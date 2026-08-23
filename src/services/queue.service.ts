import { env } from "../env.js";
import { log } from "../lib/logger.js";

const queueLog = log.child("queue");

type Task = () => Promise<void>;

/** A minimal in-process, concurrency-capped FIFO queue for build jobs. */
export class ConcurrencyQueue {
	private running = 0;
	private readonly pending: Task[] = [];

	constructor(private readonly concurrency: number) {}

	push(task: Task): void {
		this.pending.push(task);
		queueLog.debug("task pushed", { running: this.running, pending: this.pending.length });
		this.tryNext();
	}

	get stats(): { running: number; pending: number } {
		return { running: this.running, pending: this.pending.length };
	}

	private tryNext(): void {
		if (this.running >= this.concurrency) return;
		const task = this.pending.shift();
		if (!task) return;

		this.running++;
		task()
			.catch((err) => {
				queueLog.error("task threw (should have caught its own errors)", { err });
			})
			.finally(() => {
				this.running--;
				this.tryNext();
			});
	}
}

export const buildQueue = new ConcurrencyQueue(env.MAX_CONCURRENT_BUILDS);
