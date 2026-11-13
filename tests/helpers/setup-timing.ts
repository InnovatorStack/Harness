const slowSetupTestMs = 1000;

/** Diagnose slow shared setup without changing its assertions or timeout. */
export class SetupTiming implements Disposable {
    private readonly started = performance.now();
    private readonly cpu = process.cpuUsage();
    private readonly startingRssBytes = process.memoryUsage().rss;
    private readonly phases: {
        readonly name: string;
        readonly wallMs: number;
        readonly cpuMs: number;
    }[] = [];

    async phase<Result>(name: string, run: () => Promise<Result>): Promise<Result> {
        const started = performance.now();
        const cpu = process.cpuUsage();

        try {
            return await run();
        } finally {
            const used = process.cpuUsage(cpu);
            this.phases.push({
                name,
                wallMs: performance.now() - started,
                cpuMs: (used.user + used.system) / 1000,
            });
        }
    }

    [Symbol.dispose](): void {
        const wallMs = performance.now() - this.started;

        if (wallMs <= slowSetupTestMs) {
            return;
        }

        const cpu = process.cpuUsage(this.cpu);
        console.warn("Slow shared setup test", {
            wallMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            startingRssBytes: this.startingRssBytes,
            memoryBytes: process.memoryUsage(),
            phases: this.phases,
        });
    }
}
