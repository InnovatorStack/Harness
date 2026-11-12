import type { Fixtures } from "../../src/index.js";

export default {
    TestLink: [
        {
            source_id: { name: "Parent" },
            related_id: { name: "Child" },
            note: "Loaded during shared setup",
        },
    ],

    TestNode: [
        { name: "Parent", count: 9 },
        { name: "Child", count: 0 },
    ],
} satisfies Fixtures;
