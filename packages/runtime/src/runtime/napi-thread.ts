import "../shared/worker-base";
import { instantiateNapiModuleSync, MessageHandler } from "@emnapi/core";
import { WASI } from "@tybys/wasm-util";
import { asWASI, threadImports } from "./napi-wasm";

// One thread (wasi-threads) of a native addon built for WebAssembly. emnapi's
// owner sends the compiled module and its shared memory; the thread then runs
// wasi_thread_start. `self.name` is the owner's BroadcastChannel for TCP.
const handler = new MessageHandler({
	onLoad({ wasmModule, wasmMemory }) {
		return instantiateNapiModuleSync(wasmModule, {
			childThread: true,
			wasi: asWASI(new WASI({ version: "preview1", returnOnExit: true })),
			overwriteImports(imports: WebAssembly.Imports) {
				const own = threadImports(wasmMemory, self.name);
				imports.env = { ...imports.env, ...own.env, memory: wasmMemory };
				imports.neutron = own.neutron;
				return imports;
			},
		});
	},
});
self.onmessage = (event) => handler.handle(event);
