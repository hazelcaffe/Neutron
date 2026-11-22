//! Replaces `memory.atomic.wait32/64` with calls to imported functions
//! `neutron.wait32(address, expected, timeout_ns) -> i32` and
//! `neutron.wait64(address, expected, timeout_ns) -> i32`.
//!
//! Browsers trap on `memory.atomic.wait` in a page's main thread. The
//! embedder implements the imports with `Atomics.wait` where blocking is
//! allowed and spins on the value elsewhere, as Emscripten's pthreads do.
//! Return values match the instruction: 0 woken, 1 not equal, 2 timed out.

use std::collections::HashMap;

use anyhow::{Context, Result};
use walrus::ir::{dfs_pre_order_mut, Call, Instr, InstrSeqId, VisitorMut};
use walrus::{FunctionBuilder, FunctionId, LocalFunction, Module, ValType};

struct Rewriter<'a> {
    targets: &'a HashMap<(bool, u64), FunctionId>,
    replaced: usize,
}

impl VisitorMut for Rewriter<'_> {
    fn visit_instr_mut(&mut self, instr: &mut Instr, _loc: &mut walrus::InstrLocId) {
        if let Instr::AtomicWait(wait) = instr {
            let func = self.targets[&(wait.sixty_four, wait.arg.offset)];
            *instr = Instr::Call(Call { func });
            self.replaced += 1;
        }
    }
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args.next().context("usage: neutron-wasm-waits <in.wasm> <out.wasm>")?;
    let output = args.next().context("missing output path")?;
    let mut module = walrus::ModuleConfig::new()
        .generate_producers_section(false)
        .parse_file(&input)?;

    // Every (width, offset) pair used by a wait instruction.
    let mut needed = Vec::new();
    for func in module.funcs.iter_local() {
        collect(func.1, func.1.entry_block(), &mut needed);
    }
    needed.sort();
    needed.dedup();

    let memory = module.memories.iter().next().context("module has no memory")?.id();
    let i32t = ValType::I32;
    let i64t = ValType::I64;
    let ty32 = module.types.add(&[i32t, i32t, i64t], &[i32t]);
    let ty64 = module.types.add(&[i32t, i64t, i64t], &[i32t]);
    let (import32, _) = module.add_import_func("neutron", "wait32", ty32);
    let (import64, _) = module.add_import_func("neutron", "wait64", ty64);

    let mut targets = HashMap::new();
    for &(sixty_four, offset) in &needed {
        let import = if sixty_four { import64 } else { import32 };
        if offset == 0 {
            targets.insert((sixty_four, offset), import);
            continue;
        }
        // The address is below `expected` and `timeout` on the stack, so a
        // nonzero offset needs a small wrapper that adds it.
        let expected = if sixty_four { i64t } else { i32t };
        let mut builder = FunctionBuilder::new(&mut module.types, &[i32t, expected, i64t], &[i32t]);
        let address = module.locals.add(i32t);
        let value = module.locals.add(expected);
        let timeout = module.locals.add(i64t);
        builder
            .func_body()
            .local_get(address)
            .i32_const(offset as i32)
            .binop(walrus::ir::BinaryOp::I32Add)
            .local_get(value)
            .local_get(timeout)
            .call(import);
        let wrapper = builder.finish(vec![address, value, timeout], &mut module.funcs);
        targets.insert((sixty_four, offset), wrapper);
    }
    let _ = memory;

    let mut rewriter = Rewriter { targets: &targets, replaced: 0 };
    let wrappers: Vec<FunctionId> = targets.values().copied().collect();
    for (id, func) in module.funcs.iter_local_mut() {
        if wrappers.contains(&id) {
            continue;
        }
        let entry = func.entry_block();
        dfs_pre_order_mut(&mut rewriter, func, entry);
    }
    module.emit_wasm_file(&output)?;
    eprintln!(
        "replaced {} memory.atomic.wait instructions ({} variants)",
        rewriter.replaced,
        needed.len()
    );
    Ok(())
}

fn collect(func: &LocalFunction, seq: InstrSeqId, out: &mut Vec<(bool, u64)>) {
    for (instr, _) in &func.block(seq).instrs {
        match instr {
            Instr::AtomicWait(wait) => out.push((wait.sixty_four, wait.arg.offset)),
            Instr::Block(block) => collect(func, block.seq, out),
            Instr::Loop(lp) => collect(func, lp.seq, out),
            Instr::IfElse(branch) => {
                collect(func, branch.consequent, out);
                collect(func, branch.alternative, out);
            }
            _ => {}
        }
    }
}
