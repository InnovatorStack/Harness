import { afterEach, expect, test } from "bun:test";

import { createEngine } from "../src/engine.js";
import type { Engine } from "../src/engine.js";
import { ExecutionOutcome } from "../src/index.js";
import { Item } from "../src/items/item.js";
import { csharp } from "../src/methods/csharp/executor.js";
import { importPackageDocuments } from "../src/packages/module.js";
import { parseAml } from "../src/packages/parser.js";

const worlds: Engine[] = [];
const structure = Bun.fileURLToPath(
    new URL("../.harness/packages/pipeline/Import/structure.xml", import.meta.url),
);

afterEach(() => {
    for (const world of worlds.splice(0)) {
        world.close();
    }
});

async function world(name: string, code: string, event?: string): Promise<Engine> {
    const engine = createEngine({ executors: [csharp()] });
    worlds.push(engine);
    await engine.loadPackages([structure]);
    const binding = event
        ? `<Item type="Server Event" action="add">
    <source_id><Item type="ItemType" action="get"><name>TestNode</name></Item></source_id>
    <related_id><Item type="Method" action="get"><name>${name}</name></Item></related_id>
    <server_event>${event}</server_event><sort_order>10</sort_order>
  </Item>`
        : "";
    engine.runtime.executeSync(importPackageDocuments, [
        parseAml(
            `<AML>
    <Item type="Method" action="add"><name>${name}</name><method_type>C#</method_type>
      <method_code><![CDATA[${code}]]></method_code>
    </Item>${binding}
  </AML>`,
            "xml-conformance.xml",
        ),
    ]);

    return engine;
}

test("removeProperty removes an update field and its attributes without clearing the stored value", async () => {
    const engine = await world(
        "StripClassification",
        `
    this.removeProperty("classification");
    if (this.node.SelectSingleNode("classification") != null) throw new Exception("Property remains");
    return this;
  `,
        "onBeforeUpdate",
    );
    const record = engine.seed("TestNode", { name: "Before", classification: "Stored" });
    const request = engine.item(record, "update");
    request.setProperty("name", "After");
    request.setProperty("classification", "Attempted");
    request.setPropertyAttribute("classification", "is_null", "1");

    const response = await engine.apply(request);

    expect(response.isError()).toBe(false);
    expect(engine.inspect(record).properties).toMatchObject({
        name: "After",
        classification: "Stored",
    });
    const method = engine.executions.at(-1)?.calls[0]?.children[0];
    expect(method?.result).toMatchObject({ items: [{ properties: { name: "After" } }] });
}, 60_000);

test("removeProperty deletes nested Items and metadata, is idempotent and preserves unrelated nodes", async () => {
    const engine = await world(
        "RemoveNested",
        `
    this.removeProperty("owner");
    this.removeProperty("owner");
    this.removeProperty("absent");
    this.removeProperty("id");
    if (this.getPropertyItem("owner") != null) throw new Exception("Nested Item remains");
    if (this.node.SelectSingleNode("owner") != null) throw new Exception("XML remains");
    return this;
  `,
    );
    const context = Item.create("Context");
    context.setProperty("id", "CONTEXT");
    context.setProperty("name", "Keep");
    context.setPropertyItem("owner", Item.create("Identity"));
    context.setPropertyAttribute("owner", "keyed_name", "Removed");
    context.addRelationship(Item.create("Link"));

    const result = await engine.callMethod("RemoveNested", context);

    expect(result.getID()).toBe("CONTEXT");
    expect(result.node.propertyItems).not.toHaveProperty("owner");
    expect(result.node.propertyAttributes).not.toHaveProperty("owner");
    expect(result.getProperty("name")).toBe("Keep");
    expect(result.getRelationships().getItemCount()).toBe(1);
}, 60_000);

test("SelectSingleNode returns real live elements, attributes and text nodes", async () => {
    const engine = await world(
        "LiveNodes",
        `
    System.Xml.XmlElement element = (System.Xml.XmlElement)this.node.SelectSingleNode("name");
    System.Xml.XmlAttribute id = (System.Xml.XmlAttribute)this.node.SelectSingleNode("@id");
    if (this.node.SelectSingleNode("missing") != null) throw new Exception("Missing nodes must be null");
    if (element.SelectSingleNode("text()").Value != "Before") throw new Exception("Wrong text node");
    this.setProperty("name", "From Item API");
    if (element.InnerText != "From Item API") throw new Exception("Stale element");
    element.InnerText = "From DOM";
    element.SetAttribute("source", "xpath");
    if (this.getProperty("name") != "From DOM") throw new Exception("Stale property");
    if (id.Value != this.getID()) throw new Exception("Wrong attribute");
    return this;
  `,
    );
    const context = Item.create("TestNode");
    context.setProperty("id", "CONTEXT");
    context.setProperty("name", "Before");
    const result = await engine.callMethod("LiveNodes", context);

    expect(result.getProperty("name")).toBe("From DOM");
    expect(result.getPropertyAttribute("name", "source")).toBe("xpath");
}, 60_000);

test("XML before-event edits and null attributes reach SQLite through the ordinary pipeline", async () => {
    const engine = await world(
        "EditXml",
        `
    var name = (System.Xml.XmlElement)this.node.SelectSingleNode("name");
    name.InnerText = "DOM update";
    var note = (System.Xml.XmlElement)this.node.SelectSingleNode("note");
    note.SetAttribute("is_null", "1");
    return this;
  `,
        "onBeforeUpdate",
    );
    const record = engine.seed("TestNode", { name: "Before", note: "Before" });
    const request = engine.item(record, "update");
    request.setProperty("name", "Requested");
    request.setProperty("note", "Requested");

    await engine.apply(request);

    expect(engine.inspect(record).properties).toMatchObject({ name: "DOM update", note: null });
}, 60_000);

test("XPath predicates, axes, unions and namespace managers use the native XML engine", async () => {
    const engine = await world(
        "XPathQueries",
        `
    Item local = this.newItem();
    local.loadAML("<Item type='Context' xmlns:m='urn:test'><name>Outer</name><m:label>Namespaced</m:label><Relationships><Item type='Link'><rank>1</rank><name>First</name></Item><Item type='Link'><rank>2</rank><name>Second</name></Item></Relationships></Item>");
    var namespaces = new System.Xml.XmlNamespaceManager(local.node.OwnerDocument.NameTable);
    namespaces.AddNamespace("m", "urn:test");
    var selected = local.node.SelectSingleNode("Relationships/Item[rank='2' and contains(name,'Sec')]/name");
    var first = local.node.SelectSingleNode("descendant::Item[@type='Link'][position()=1]/name");
    var ancestor = selected.SelectSingleNode("ancestor::Item[1]/@type");
    var union = local.node.SelectNodes("name | Relationships/Item/name");
    string label = local.node.SelectSingleNode("m:label", namespaces).InnerText;
    return this.getInnovator().newResult(string.Join("|", selected.InnerText, first.InnerText, ancestor.Value, union.Count, label));
  `,
    );
    const result = await engine.callMethod("XPathQueries", Item.create("Context"));

    expect(result.getResult()).toBe("Second|First|Link|3|Namespaced");
}, 60_000);

test("XPath-selected Items and existing XmlElement references share updates without replacing the source document", async () => {
    const engine = await world(
        "SelectedItems",
        `
    Item local = this.newItem();
    local.loadAML("<Item type='Context'><Relationships><Item type='Link' id='CHILD'><name>Before</name></Item></Relationships></Item>");
    var element = (System.Xml.XmlElement)local.node.SelectSingleNode("Relationships/Item/name");
    var root = local.node;
    Item selected = local.getItemsByXPath("//Item[@type='Link']");
    selected.setProperty("name", "Changed");
    if (!object.ReferenceEquals(root, local.node)) throw new Exception("Source document replaced");
    if (element.InnerText != "Changed") throw new Exception("Detached selection");
    if (local.getItemsByXPath("//Item[@type='Absent']").getItemCount() != 0) throw new Exception("Wrong empty result");
    return local;
  `,
    );
    const result = await engine.callMethod("SelectedItems", Item.create("Context"));

    expect(result.getRelationships("Link").getItemByIndex(0).getProperty("name")).toBe("Changed");
}, 60_000);

test("cached DOM projections observe nested edits, attribute changes and removals", async () => {
    const engine = await world(
        "ChangedProjection",
        `this.loadAML("<Item type='Context'><name>Before</name><obsolete>Remove</obsolete>" +
            "<Relationships><Item type='Link'><name>Child before</name></Item></Relationships></Item>");
        var initial = this.dom.OuterXml;
        var child = this.getRelationships("Link").getItemByIndex(0);
        var childInitial = child.dom.OuterXml;
        child.node.SelectSingleNode("name").InnerText = "Child after";
        this.node.SetAttribute("changed", "1");
        this.node.SelectSingleNode("name").InnerText = "After";
        this.removeProperty("obsolete");
        var updated = this.dom.OuterXml;
        child.node.SelectSingleNode("name").InnerText = "Child final";
        return this;`,
    );
    const result = await engine.callMethod("ChangedProjection", Item.create("Context"));

    expect(result.getProperty("name")).toBe("After");
    expect(result.getAttribute("changed")).toBe("1");
    expect(result.node.properties).not.toHaveProperty("obsolete");
    expect(result.getRelationships("Link").getItemByIndex(0).getProperty("name")).toBe(
        "Child final",
    );
}, 60_000);

test("nested Item and relationship helpers keep attached views live across document imports", async () => {
    const engine = await world(
        "AttachedNodes",
        `
    Item parent = this.newItem("Context");
    Item child = this.newItem("Identity");
    child.setProperty("name", "Before");
    parent.setPropertyItem("owner", child);
    child.setProperty("name", "After attachment");
    Item held = parent.getPropertyItem("owner");
    held.node.SelectSingleNode("name").InnerText = "From held view";
    if (child.getProperty("name") != "From held view") throw new Exception("Item alias disconnected");
    Item relationship = this.newItem("Link");
    relationship.setProperty("note", "Before");
    parent.addRelationship(relationship);
    relationship.setProperty("note", "After");
    if (parent.getRelationships("Link").getProperty("note") != "After") throw new Exception("Relationship alias disconnected");
    return parent;
  `,
    );
    const result = await engine.callMethod("AttachedNodes", Item.create("Context"));

    expect(result.getPropertyItem("owner")?.getProperty("name")).toBe("From held view");
    expect(result.getRelationships("Link").getProperty("note")).toBe("After");
}, 60_000);

test("read-only XML inspection preserves numeric and null transport values and property metadata", async () => {
    const engine = await world(
        "PreserveValues",
        `
    foreach (System.Xml.XmlElement property in this.node.SelectNodes("*")) {
      string text = property.InnerText;
    }
    Item empty = this.newItem();
    empty.setID("");
    if (empty.getProperty("id", "fallback") != "fallback") throw new Exception("Missing ID fallback lost");
    return this;
  `,
    );
    const context = Item.create("TestNode");
    context.setProperty("id", "CONTEXT");
    context.setProperty("count", 5);
    context.setProperty("note", null);
    context.setPropertyAttribute("count", "source", "input");

    const result = await engine.callMethod("PreserveValues", context);

    expect(result.node.properties).toMatchObject({ count: 5, note: null });
    expect(result.getPropertyAttribute("count", "source")).toBe("input");
    expect(result.getID()).toBe("CONTEXT");
}, 60_000);

test("setting a nonnull value clears the XML null marker", async () => {
    const engine = await world("SetValue", 'this.setProperty("note", "Restored"); return this;');
    const context = Item.create("TestNode");
    context.setProperty("note", null);
    context.setPropertyAttribute("note", "is_null", "1");
    const result = await engine.callMethod("SetValue", context);

    expect(result.node.properties.note).toBe("Restored");
    expect(result.getPropertyAttribute("note", "is_null")).toBe("");
}, 60_000);

test("invalid XPath fails the owning request and rolls back earlier writes", async () => {
    const engine = await world(
        "InvalidXPath",
        `
    Item record = this.newItem("TestNode", "add"); record.setProperty("name", "Transient"); record.apply();
    this.node.SelectSingleNode("//*[");
    return this;
  `,
    );

    await expect(engine.callMethod("InvalidXPath", Item.create("Context"))).rejects.toThrow(
        "XPath",
    );
    expect(engine.storage.listItems("TestNode")).toEqual([]);
    expect(engine.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
    expect(engine.executions.at(-1)?.changes[0]?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("getItemsByXPath rejects non-Item selections rather than inventing Item wrappers", async () => {
    const engine = await world("InvalidItemSelection", 'return this.getItemsByXPath("//name");');
    const context = Item.create("Context");
    context.setProperty("name", "Present");

    await expect(engine.callMethod("InvalidItemSelection", context)).rejects.toThrow(
        "Item XPath must select Item elements",
    );
}, 60_000);

test("loadAML rejects DTDs and unsupported XML shapes cannot silently lose data at the Bun boundary", async () => {
    const engine = await world(
        "InvalidXml",
        `
    Item local = this.newItem();
    local.loadAML(this.getProperty("xml"));
    return local;
  `,
    );
    const context = Item.create("Context");
    context.setProperty(
        "xml",
        '<!DOCTYPE Item [<!ENTITY external SYSTEM "file:///unavailable">]><Item><name>&external;</name></Item>',
    );
    await expect(engine.callMethod("InvalidXml", context)).rejects.toThrow("DTD");

    context.setProperty("xml", "<Item><metadata><Value>Cannot flatten</Value></metadata></Item>");
    await expect(engine.callMethod("InvalidXml", context)).rejects.toThrow(
        "one Item in nested property 'metadata'",
    );
}, 60_000);

test("caught transport limitations cannot commit earlier writes as a successful Method", async () => {
    const engine = await world(
        "CaughtTransportLimitation",
        `
    Item record = this.newItem("TestNode", "add"); record.setProperty("name", "Transient"); record.apply();
    try {
      Item unsupported = this.newItem();
      unsupported.loadAML("<Item type='TestNode'><metadata><Value>Unsupported</Value></metadata></Item>");
      unsupported.apply();
    } catch (Exception) { }
    return this;
  `,
    );

    await expect(
        engine.callMethod("CaughtTransportLimitation", Item.create("Context")),
    ).rejects.toMatchObject({ code: "UnsupportedCapability" });
    expect(engine.storage.listItems("TestNode")).toEqual([]);
    expect(engine.executions.at(-1)?.outcome).toBe(ExecutionOutcome.RolledBack);
}, 60_000);

test("expanded item projections retain both reference IDs and live nested Item views", async () => {
    const engine = await world(
        "ExpandedReference",
        `
    Item query = this.newItem("TestNode", "get");
    query.setID(this.getProperty("target"));
    query.setAttribute("select", "id,name,parent(id,name)");
    Item result = query.apply();
    if (result.getProperty("parent") != this.getProperty("parent_id")) throw new Exception("Reference ID lost");
    Item parent = result.getPropertyItem("parent");
    if (parent == null || parent.getProperty("name") != "Parent") throw new Exception("Expansion lost");
    parent.node.SelectSingleNode("name").InnerText = "Response view";
    return result;
  `,
    );
    const parent = engine.seed("TestNode", { name: "Parent" });
    const child = engine.seed("TestNode", { name: "Child", parent });
    const context = Item.create("Context");
    context.setProperty("target", child.id);
    context.setProperty("parent_id", parent.id);

    const result = await engine.callMethod("ExpandedReference", context);

    expect(result.getProperty("parent")).toBe(parent.id);
    expect(result.getPropertyItem("parent")?.getProperty("name")).toBe("Response view");
    expect(engine.inspect(parent).properties.name).toBe("Parent");
}, 60_000);
