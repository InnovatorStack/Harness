import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineOperation, RuntimeError } from "../src/core/index.js";
import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { SqliteStorage } from "../src/storage/sqlite/index.js";
import type { CatalogEntry } from "../src/storage/types.js";

const fixtureXml = `<AML>
  <Item type="ItemType" action="add" id="TEST_TASK_TYPE">
    <name>TestTask</name>
    <Relationships>
      <Item type="Property" action="add" id="TEST_TASK_NAME"><name>name</name><data_type>string</data_type></Item>
      <Item type="Property" action="add" id="TEST_TASK_COUNT"><name>count</name><data_type>integer</data_type></Item>
    </Relationships>
  </Item>
  <Item type="TestTask" action="add" id="TASK"><name>Inspect</name><count>0</count></Item>
</AML>`;

function gate() {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return {
        promise,

        release() {
            if (!release) {
                throw new Error("Gate is not initialized.");
            }

            release();
        },
    };
}

function expectWorldBusy(action: () => void): void {
    try {
        action();
    } catch (error) {
        expect(error).toBeInstanceOf(RuntimeError);

        if (!(error instanceof RuntimeError)) {
            throw error;
        }

        expect(error.code).toBe("WorldBusy");

        return;
    }

    throw new Error("Expected a WorldBusy error.");
}

describe("createEngine", () => {
    const harnesses: Engine[] = [];
    const directories: string[] = [];

    function fixtureFile(): string {
        const directory = mkdtempSync(join(tmpdir(), "innovator-harness-api-"));
        directories.push(directory);
        const file = join(directory, "fixture.xml");
        writeFileSync(file, fixtureXml);

        return file;
    }

    function track(harness: Engine): Engine {
        harnesses.push(harness);

        return harness;
    }

    afterEach(() => {
        for (const harness of harnesses.splice(0)) {
            harness.close();
        }

        for (const directory of directories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("bootstraps the default world and imports explicit package paths", async () => {
        const harness = track(createEngine());
        expect(
            harness.storage
                .listCatalogEntries("ItemType")
                .some((entry) => entry.properties.name === "Method"),
        ).toBe(true);
        expect(
            harness.storage
                .listItems("User")
                .some((user) => user.properties.login_name === "admin"),
        ).toBe(true);

        const file = fixtureFile();
        const report = await harness.loadPackages([file]);

        expect(harness.storage.getItem("TestTask", "TASK")?.properties).toEqual({
            name: "Inspect",
            count: 0,
        });
        expect(report.documents).toHaveLength(1);
        expect(report.documents[0]?.path).toBe(file);
        expect(harness.storage.listDocuments()[0]?.xml).toBe(fixtureXml);
        expect(harness.runtime.trace.at(-1)?.phase).toBe("success");
    });

    test("a failed module reset closes the world instead of leaving partially reset state usable", () => {
        let disposals = 0;
        const harness = track(
            createEngine({
                modules: [
                    {
                        id: "test.broken-reset",

                        setup() {},

                        reset() {
                            throw new Error("Reset failed");
                        },

                        dispose() {
                            disposals += 1;
                        },
                    },
                ],
            }),
        );
        expect(() => harness.reset()).toThrow("Reset failed");
        expect(disposals).toBe(1);
        expect(() => harness.checkpoint()).toThrow("The harness is closed");
        expect(() => harness.storage.listItemTypes()).toThrow("SQLite storage is closed");
    });

    test("checkpoint and reset restore stored state, clear traces and reset module state", async () => {
        const storage = new SqliteStorage();
        const write = defineOperation<number, void>("test.write-task");
        let moduleValue = 0;
        let resets = 0;
        const harness = track(
            createEngine({
                storage,
                modules: [
                    {
                        id: "test.task",
                        requires: ["packages"],

                        setup(registrar) {
                            registrar.handleSync(write, (value) => {
                                moduleValue = value;
                                storage.updateItem("TestTask", "TASK", { count: value });
                            });
                        },

                        reset() {
                            moduleValue = 0;
                            resets += 1;
                        },
                    },
                ],
            }),
        );
        await harness.loadPackages([fixtureFile()]);
        harness.checkpoint();
        harness.runtime.executeSync(write, 7);
        expect(moduleValue).toBe(7);
        expect(storage.getItem("TestTask", "TASK")?.properties.count).toBe(7);

        harness.reset();

        expect(storage.getItem("TestTask", "TASK")?.properties.count).toBe(0);
        expect(storage.listDocuments()).toHaveLength(1);
        expect(harness.runtime.trace).toEqual([]);
        expect(moduleValue).toBe(0);
        expect(resets).toBe(1);
        harness.runtime.executeSync(write, 2);
        harness.reset();
        expect(storage.getItem("TestTask", "TASK")?.properties.count).toBe(0);
        expect(resets).toBe(2);
    });

    test("baseline changes and close are refused while package inputs are being read", async () => {
        const harness = track(createEngine());
        const loading = harness.loadPackages([fixtureFile()]);
        expect(harness.runtime.isBusy).toBe(false);
        expectWorldBusy(() => harness.checkpoint());
        expectWorldBusy(() => harness.reset());
        expectWorldBusy(() => harness.close());
        await loading;
        harness.checkpoint();
        harness.reset();
        expect(harness.storage.getItem("TestTask", "TASK")).toBeDefined();
    });

    test("baseline changes and close are refused for queued and active operations", async () => {
        const started = gate();
        const finish = gate();
        const wait = defineOperation<void, void>("test.wait");
        const harness = track(
            createEngine({
                modules: [
                    {
                        id: "test.waiting",

                        setup(registrar) {
                            registrar.handleAsync(wait, async () => {
                                started.release();
                                await finish.promise;
                            });
                        },
                    },
                ],
            }),
        );
        const running = harness.runtime.execute(wait, undefined);

        try {
            expectWorldBusy(() => harness.checkpoint());
            expectWorldBusy(() => harness.reset());
            expectWorldBusy(() => harness.close());
            await started.promise;
            expectWorldBusy(() => harness.checkpoint());
            expectWorldBusy(() => harness.reset());
            expectWorldBusy(() => harness.close());
        } finally {
            finish.release();
            await running;
        }

        harness.checkpoint();
        harness.reset();
        expect(harness.runtime.trace).toEqual([]);
    });

    test("owns supplied storage and disposes modules once when closed", async () => {
        const storage = new SqliteStorage();
        let disposals = 0;
        const harness = track(
            createEngine({
                storage,
                modules: [
                    {
                        id: "test.lifecycle",

                        setup() {},

                        dispose() {
                            disposals += 1;
                        },
                    },
                ],
            }),
        );
        expect(harness.storage).toBe(storage);
        harness.close();
        harness.close();
        expect(disposals).toBe(1);
        expect(() => storage.listItemTypes()).toThrow("closed");
        expect(() => harness.reset()).toThrow("closed");
        expect(() => harness.checkpoint()).toThrow("closed");
        await expect(harness.loadPackages([])).rejects.toThrow("closed");
    });

    test("rejects conflicting storage options before taking ownership", () => {
        const storage = new SqliteStorage();

        try {
            expect(() => createEngine({ storage, database: ":memory:" })).toThrow("not both");
            expect(storage.listItemTypes()).toEqual([]);
        } finally {
            storage.close();
        }
    });

    test("close releases storage and retains both failures when module and storage disposal fail", () => {
        class FailingCloseStorage extends SqliteStorage {
            override close(): void {
                super.close();

                throw new Error("Storage cleanup failed.");
            }
        }

        const storage = new FailingCloseStorage();
        const harness = track(
            createEngine({
                storage,
                modules: [
                    {
                        id: "test.failing-cleanup",

                        setup() {},

                        dispose() {
                            throw new Error("Module cleanup failed.");
                        },
                    },
                ],
            }),
        );
        let failure: unknown;

        try {
            harness.close();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);

        if (!(failure instanceof AggregateError)) {
            throw new TypeError("Expected both cleanup failures.");
        }

        expect(failure.errors).toHaveLength(2);
        expect(String(failure.errors[0])).toContain("Module cleanup failed");
        expect(String(failure.errors[1])).toContain("Storage cleanup failed");
        expect(() => storage.listItemTypes()).toThrow("SQLite storage is closed");
        expect(() => harness.checkpoint()).toThrow("The harness is closed");
        expect(() => harness.close()).not.toThrow();
    });

    test("a bootstrap failure closes the runtime modules and storage", () => {
        class FailingBootstrapStorage extends SqliteStorage {
            override putCatalogEntry(_entry: CatalogEntry): void {
                throw new Error("Bootstrap failed.");
            }
        }

        const storage = new FailingBootstrapStorage();
        let disposals = 0;
        expect(() =>
            createEngine({
                storage,
                modules: [
                    {
                        id: "test.cleanup",

                        setup() {},

                        dispose() {
                            disposals += 1;
                        },
                    },
                ],
            }),
        ).toThrow("Bootstrap failed.");
        expect(disposals).toBe(1);
        expect(() => storage.listItemTypes()).toThrow("closed");
    });

    test("an initial checkpoint failure also disposes constructed resources", () => {
        class FailingSnapshotStorage extends SqliteStorage {
            override snapshot(): Uint8Array {
                throw new Error("Snapshot failed.");
            }
        }

        const storage = new FailingSnapshotStorage();
        let disposals = 0;
        expect(() =>
            createEngine({
                storage,
                modules: [
                    {
                        id: "test.cleanup",

                        setup() {},

                        dispose() {
                            disposals += 1;
                        },
                    },
                ],
            }),
        ).toThrow("Snapshot failed.");

        try {
            expect(disposals).toBe(1);
            expect(() => storage.listItemTypes()).toThrow("closed");
        } finally {
            storage.close();
        }
    });
});
