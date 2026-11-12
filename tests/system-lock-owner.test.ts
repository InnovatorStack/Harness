import { expect, test } from "bun:test";

import { createHarness } from "../src/index.js";
import { unlockProject } from "./helpers/unlock-events.js";

test.each([false, true])(
    "generated lock metadata targets the imported User schema: replacement=%s",
    async (replacement) => {
        const metadata = replacement
            ? `<Item type="ItemType" action="add" id="CF200000000000000000000000000001"><name>User</name></Item>`
            : "";
        await using project = await unlockProject(metadata);
        using h = await createHarness({ cwd: project.cwd });
        const type = h.state.getOne("ItemType", { name: "ReferenceRecord" });
        const userType = h.state.getOne("ItemType", { name: "User" });
        const ownerProperty = h.state.getOne("Property", {
            source_id: type.id,
            name: "locked_by_id",
        });
        const user = h.state.getOne("User", { login_name: "reference_owner" });
        const record = h.state.getOne("ReferenceRecord", { name: "First locked source" });

        expect(ownerProperty.properties.data_source).toBe(userType.id);
        expect(record.properties.locked_by_id).toBe(user.id);
        const result = await h.applyAML(
            `<Item type="ReferenceRecord" action="get" id="${record.id}" select="locked_by_id(login_name)" />`,
        );

        expect(result.node.propertyItems.locked_by_id?.properties.login_name).toBe(
            "reference_owner",
        );
    },
);
