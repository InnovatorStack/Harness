import { API } from "typescript/unstable/async";
import type { Project, Snapshot } from "typescript/unstable/async";

/** One owner disposes both native compiler resources, including failure during disposal. */
export async function withProject<Value>(
    directory: string,
    work: (project: Project) => Promise<Value>,
): Promise<Value> {
    const compiler = new API({ cwd: directory });
    const failures: unknown[] = [];
    let snapshot: Snapshot | undefined;
    let result: { value: Value } | undefined;

    try {
        snapshot = await compiler.updateSnapshot({ openProjects: ["tsconfig.json"] });
        const project = snapshot.getProject("tsconfig.json");

        if (!project) {
            throw new Error("The style checker could not open tsconfig.json.");
        }

        result = { value: await work(project) };
    } catch (error) {
        failures.push(error);
    }

    try {
        await snapshot?.dispose();
    } catch (error) {
        failures.push(error);
    }

    try {
        await compiler.close();
    } catch (error) {
        failures.push(error);
    }

    if (failures.length === 1) {
        throw failures[0];
    }

    if (failures.length > 1) {
        throw new AggregateError(failures, "Style inspection and compiler cleanup failed.");
    }

    if (!result) {
        throw new Error("A completed style inspection must have a result.");
    }

    return result.value;
}
