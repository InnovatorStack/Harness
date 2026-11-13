import type { Item } from "../../src/items/item.js";
import { csharp } from "../../src/methods/csharp/index.js";
import type { MethodExecutor } from "../../src/methods/types.js";
import { referenceEvent, referenceMethod } from "./references.js";

export interface MethodContextObservation {
    readonly method: string;
    readonly context: Item;
}

export function observingCSharp(observations: MethodContextObservation[]): () => MethodExecutor {
    return () => {
        const executor = csharp();

        return {
            language: executor.language,

            async execute(method, context, ports) {
                try {
                    return await executor.execute(method, context, ports);
                } finally {
                    observations.push({ method: method.name, context: context.clone() });
                }
            },

            reset() {
                executor.reset?.();
            },

            dispose() {
                executor.dispose?.();
            },
        };
    };
}

export const inspectFailedBase = `// MethodTemplateName = CSharpInOut;
var input = inDom.DocumentElement ?? throw new Exception("Missing input");
var name = input.SelectSingleNode("name");
bool failed = false;
try { eventData.BaseUpdateItem(outDom); }
catch (Exception) { failed = true; }
failed = failed || outDom.SelectSingleNode("//*[local-name()='Fault']") != null;
if (failed)
{
    bool verified = input.SelectSingleNode("name")?.InnerText == "Hook mutation"
        && input.SelectSingleNode("temporary_marker")?.InnerText == "Pending only"
        && input.SelectSingleNode("rejection_marker")?.InnerText == "Rejected later"
        && !input.HasAttribute("where") && !input.HasAttribute("idlist")
        && Object.ReferenceEquals(name, input.SelectSingleNode("name"));
    var marker = inDom.CreateElement("caller_verified");
    marker.InnerText = verified ? "true" : "false";
    input.AppendChild(marker);
}`;

export function failedVersionSources(failure: "return" | "throw", separate: boolean): string {
    const mutation = `this.setProperty("name", "Hook mutation");
        this.setProperty("temporary_marker", "Pending only");`;
    const reject =
        failure === "return"
            ? 'return this.getInnovator().newError("Version hook rejected");'
            : 'throw new Exception("Version hook rejected");';
    const source = separate ? "" : mutation;
    let methods =
        referenceMethod("InspectFailedBase", inspectFailedBase) +
        referenceEvent("REF_RECORD", "onUpdate", "InspectFailedBase") +
        referenceMethod(
            "RejectVersion",
            `${source}
            string rejectAt = this.getProperty("reject_at");
            if (!String.IsNullOrEmpty(rejectAt) && this.getID() != rejectAt) { return this; }
            var note = this.newItem("ReferenceHolder", "add");
            note.setProperty("name", "Must roll back");
            var saved = note.apply();
            if (saved.isError()) { return saved; }
            this.setProperty("rejection_marker", "Rejected later");
            ${reject}`,
        ) +
        referenceEvent("REF_RECORD", "onBeforeVersion", "RejectVersion", { order: 20 });

    if (separate) {
        methods +=
            referenceMethod("MutateVersion", `${mutation} return this;`) +
            referenceEvent("REF_RECORD", "onBeforeVersion", "MutateVersion", { order: 10 });
    }

    return methods;
}
