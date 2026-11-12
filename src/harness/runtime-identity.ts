import { readBinaryFile } from "../core/files.js";

const directory = Bun.fileURLToPath(new URL("..", import.meta.url));
let identity: Promise<string> | undefined;

/** A setup image belongs to this exact runtime, including baseline data and seeding behavior. */
export function runtimeIdentity(): Promise<string> {
    identity ??= hashRuntime();

    return identity;
}

async function hashRuntime(): Promise<string> {
    const paths = [
        ...new Bun.Glob("**/*.{js,ts,json,bin,cs,template,csproj,Config}").scanSync({
            cwd: directory,
        }),
    ]
        .filter(
            (path) =>
                !path.endsWith(".d.ts") &&
                !path.split("/").some((part) => part === "bin" || part === "obj"),
        )
        .sort();
    const hash = new Bun.CryptoHasher("sha256").update(Bun.version);

    for (let offset = 0; offset < paths.length; offset += 32) {
        const sources = await Promise.all(
            paths.slice(offset, offset + 32).map(async (path) => ({
                path,
                bytes: await readBinaryFile(`${directory}/${path}`),
            })),
        );

        for (const source of sources) {
            hash.update(JSON.stringify([source.path, source.bytes.length])).update(source.bytes);
        }
    }

    return hash.digest("hex");
}
