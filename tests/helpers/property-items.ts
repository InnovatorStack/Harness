export const replaceSameDocumentItem = `
var parent = this.newItem();
parent.loadAML("<Item type='ReferenceRecord'><fixed_ref keyed_name='Keep' is_null='1'><Item type='ReferenceRecord'><name>Child</name></Item><!--Keep sibling--></fixed_ref></Item>");
var property = parent.node.SelectSingleNode("fixed_ref");
var retained = parent.getPropertyItem("fixed_ref");
var argument = parent.getPropertyItem("fixed_ref");
var previous = retained.node;
var name = previous.SelectSingleNode("name");
var sibling = previous.NextSibling;
var returned = parent.setPropertyItem("fixed_ref", argument);
var current = property.SelectSingleNode("Item");
if (!Object.ReferenceEquals(returned, argument)
    || !Object.ReferenceEquals(parent.node.SelectSingleNode("fixed_ref"), property)
    || !Object.ReferenceEquals(argument.node, current)
    || Object.ReferenceEquals(previous, current) || previous.ParentNode != null
    || !Object.ReferenceEquals(retained.node, previous)
    || !Object.ReferenceEquals(name, previous.SelectSingleNode("name"))
    || !Object.ReferenceEquals(sibling.ParentNode, property)
    || property.Attributes["keyed_name"]?.Value != "Keep"
    || property.Attributes["is_null"]?.Value != "1")
{
    throw new Exception("Same-document replacement did not preserve native Item aliases");
}
argument.setProperty("name", "Changed copy");
if (retained.getProperty("name") != "Child"
    || parent.getPropertyItem("fixed_ref").getProperty("name") != "Changed copy")
{
    throw new Exception("The detached Item and imported copy still share mutable data");
}
return this.getInnovator().newResult("Copies verified");`;

export const replaceForeignDocumentItem = `
var parent = this.newItem("ReferenceRecord");
parent.setProperty("fixed_ref", "Previous scalar");
var argument = this.newItem("ReferenceRecord");
var nested = this.newItem("ReferenceRecord");
nested.setProperty("name", "Nested source");
argument.setPropertyItem("fixed_ref", nested);
var retainedChild = argument.getPropertyItem("fixed_ref");
var original = argument.node;
var originalDocument = argument.dom;
parent.setPropertyItem("fixed_ref", argument);
var current = parent.getPropertyItem("fixed_ref");
if (Object.ReferenceEquals(original, argument.node)
    || !Object.ReferenceEquals(original.OwnerDocument, originalDocument)
    || original.ParentNode == null
    || !Object.ReferenceEquals(current.node, argument.node)
    || !Object.ReferenceEquals(argument.dom, parent.dom)
    || Object.ReferenceEquals(retainedChild.node, argument.getPropertyItem("fixed_ref").node))
{
    throw new Exception("A foreign-document replacement moved or rebound original aliases");
}
retainedChild.setProperty("name", "Detached source changed");
if (argument.getPropertyItem("fixed_ref").getProperty("name") != "Nested source")
{
    throw new Exception("An imported nested Item still shares its source data");
}
return this.getInnovator().newResult("Copies verified");`;
