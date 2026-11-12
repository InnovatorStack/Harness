import type { Database } from "bun:sqlite";

const connectionsMax = 4;
const connectionBytesMax = 64 * 1024 * 1024;
const connections = new Map<Uint8Array, Database>();
let bytes = 0;

/** Retain clean native connections, never a disposed world's storage wrapper or callbacks. */
export function takeConnection(image: Uint8Array): Database | undefined {
    const connection = connections.get(image);

    if (connection) {
        connections.delete(image);
        bytes -= image.byteLength;
    }

    return connection;
}

export function retainConnection(image: Uint8Array, connection: Database): boolean {
    if (image.byteLength > connectionBytesMax) {
        return false;
    }

    takeConnection(image)?.close();

    while (connections.size >= connectionsMax || bytes + image.byteLength > connectionBytesMax) {
        const oldest = connections.keys().next().value;

        if (oldest === undefined) {
            throw new Error("Connection eviction requires an existing idle database.");
        }

        takeConnection(oldest)?.close();
    }

    connections.set(image, connection);
    bytes += image.byteLength;

    return true;
}

process.once("exit", () => {
    for (const connection of connections.values()) {
        connection.close();
    }

    connections.clear();
});
