import type { EngineImage } from "../engine/instance.js";

const imagesMax = 4;
const imageBytesMax = 64 * 1024 * 1024;

/** Retain immutable setup images, never worlds, connections, executors or test mutations. */
export class SetupCache {
    private readonly images = new Map<string, EngineImage>();
    private bytes = 0;

    get(key: string): EngineImage | undefined {
        const image = this.images.get(key);

        if (image) {
            this.images.delete(key);
            this.images.set(key, image);
        }

        return image;
    }

    put(key: string, image: EngineImage): void {
        if (image.database.byteLength > imageBytesMax) {
            return;
        }

        this.remove(key);

        while (
            this.images.size >= imagesMax ||
            this.bytes + image.database.byteLength > imageBytesMax
        ) {
            const oldest = this.images.keys().next().value;

            if (oldest === undefined) {
                throw new Error("Setup image eviction requires an existing image.");
            }

            this.remove(oldest);
        }

        this.images.set(key, image);
        this.bytes += image.database.byteLength;
    }

    private remove(key: string): void {
        const image = this.images.get(key);

        if (image) {
            this.bytes -= image.database.byteLength;
            this.images.delete(key);
        }
    }
}

export const setupCache = new SetupCache();
