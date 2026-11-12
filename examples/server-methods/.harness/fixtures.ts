import type { Fixtures } from "@innovatorstack/harness";

export default {
    ExampleReview: [
        {
            name: "Incomplete review",
            remark: "Original",
            missing_info: "A required attachment is missing",
            approved_on: "2026-01-01T00:00:00",
        },
        {
            name: "Complete review",
            remark: "Original",
            missing_info: "",
            approved_on: "2026-01-01T00:00:00",
        },
    ],
} satisfies Fixtures;
