import { errorText, type RpcMessage, type RpcResult } from "../shared/types";

export class RpcClient {
	private next = 0;
	private pending = new Map<
		number,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	constructor(private send: (message: RpcMessage) => void) {}
	call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
		return new Promise((resolve, reject) => {
			const id = ++this.next;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Runtime request timed out: ${method}`));
			}, 60_000);
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			this.send({ type: "rpc", id, method, args });
		});
	}
	receive(message: RpcResult): void {
		const item = this.pending.get(message.id);
		if (!item) return;
		clearTimeout(item.timer);
		this.pending.delete(message.id);
		if (message.error) item.reject(new Error(message.error));
		else item.resolve(message.value);
	}
	close(): void {
		for (const item of this.pending.values()) {
			clearTimeout(item.timer);
			item.reject(new Error("Runtime stopped"));
		}
		this.pending.clear();
	}
}
export async function answerRpc(
	message: RpcMessage,
	handler: (method: string, args: unknown[]) => unknown,
	send: (result: RpcResult) => void,
): Promise<void> {
	try {
		send({
			type: "result",
			id: message.id,
			value: await handler(message.method, message.args),
		});
	} catch (error) {
		send({ type: "result", id: message.id, error: errorText(error) });
	}
}
