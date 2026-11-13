export const reloadSharedDocument = `
var parent = this.newItem();
parent.loadAML("<Item type='ReferenceRecord' id='A'><name>Original</name><fixed_ref><Item type='ReferenceRecord' id='B'><name>Child</name></Item></fixed_ref></Item>");
var document = parent.dom;
var original = parent.node;
var alias = parent.getItemsByXPath("/Item");
var child = parent.getPropertyItem("fixed_ref");
child.loadAML("<Item type='ReferenceRecord' id='C'><name>Reloaded</name></Item>");
if (!Object.ReferenceEquals(document, child.dom)
    || !Object.ReferenceEquals(document, parent.dom)
    || !Object.ReferenceEquals(original, parent.node)
    || !Object.ReferenceEquals(original, alias.node) || original.ParentNode != null
    || parent.getID() != "A" || parent.getProperty("name") != "Original"
    || child.getID() != "C" || parent.ToString() != document.OuterXml
    || !Object.ReferenceEquals(parent, parent.getItemByIndex(0)))
{
    throw new Exception("Shared document reload lost native Item ownership");
}
return this.getInnovator().newResult("Document views verified");`;

export const reloadCollectionDocument = `
var collection = this.newItem();
collection.loadAML("<Result><Item type='ReferenceRecord' id='A' /><Item type='ReferenceRecord' id='B' /></Result>");
var document = collection.dom;
var previousRoot = document.DocumentElement;
var first = collection.getItemByIndex(0);
var original = first.node;
collection.loadAML("<Result><Item type='ReferenceRecord' id='C' /></Result>");
if (!Object.ReferenceEquals(document, collection.dom)
    || first.getID() != "A" || previousRoot.ParentNode != null
    || !Object.ReferenceEquals(original.ParentNode, previousRoot)
    || first.ToString() != collection.ToString() || collection.getItemCount() != 1)
{
    throw new Exception("Reloading a collection rebound retained Item selections");
}
return this.getInnovator().newResult("Document views verified");`;

export const inspectLiveDocument = `
var value = this.getInnovator().newResult("Before");
var document = value.dom;
document.SelectSingleNode("//Result").InnerText = "After";
if (!Object.ReferenceEquals(document, value.dom) || value.getResult() != "After"
    || value.getItemCount() != -1 || value.ToString() != document.OuterXml)
{
    throw new Exception("Scalar inspection did not read its stable document");
}
document.LoadXml("<SOAP-ENV:Envelope xmlns:SOAP-ENV='http://schemas.xmlsoap.org/soap/envelope/'><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>0</faultcode><faultstring>Missing</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>");
if (!value.isError() || value.getErrorCode() != "0" || value.getErrorString() != "Missing"
    || value.getItemCount() != 0)
{
    throw new Exception("Fault inspection did not read the current document");
}
return this.getInnovator().newResult("Document views verified");`;

export const returnCollectionView = `
var collection = this.newItem();
collection.loadAML("<Result><Item type='ReferenceRecord' id='A'><name>First</name></Item><Item type='ReferenceRecord' id='B'><name>Second</name></Item></Result>");
return collection.getItemByIndex(0);`;

export const reloadRawInput = `
var original = this.node;
var document = original.OwnerDocument;
document.LoadXml("<Item type='ReferenceRecord' id='C'><name>From document</name></Item>");
if (!Object.ReferenceEquals(original, this.node) || original.ParentNode != null
    || this.getProperty("name") != "Original" || this.ToString() != document.OuterXml)
{
    throw new Exception("Raw document reload changed the selected Item view");
}
return this.getInnovator().newResult("Document views verified");`;

export const inspectDocumentFields = `
var value = this.newItem();
value.loadAML("<Item type='ReferenceRecord' id='A'><name>Selected</name></Item>");
var selected = value.node;
var other = this.newItem();
other.loadAML("<Result><Item type='ReferenceRecord' id='B' /><Item type='ReferenceRecord' id='C' /></Result>");
value.dom = other.dom;
value.nodeList = other.nodeList;
if (!Object.ReferenceEquals(selected, value.node) || value.getID() != "A"
    || value.getItemCount() != 2 || value.getItemByIndex(1).getID() != "C"
    || value.ToString() != other.ToString())
{
    throw new Exception("Assigning native fields rebound an independent view");
}
value.node = null;
value.nodeList = null;
value.dom = null;
if (value.getItemCount() != -1 || value.isError() || value.getResult() != ""
    || !Object.ReferenceEquals(value, value.getItemByIndex(0)))
{
    throw new Exception("Clearing native fields left an implicit Item selection");
}
value.loadAML("<Item type='ReferenceRecord' id='D' />");
if (value.getID() != "D" || value.getItemCount() != 1 || value.nodeList != null)
{
    throw new Exception("Loading an empty Item did not initialize its new document");
}
return this.getInnovator().newResult("Document views verified");`;

export const rejectDetachedActions = `
var value = this.newItem();
value.loadAML("<Item type='ReferenceRecord' id='A' action='get'><name>Detached</name></Item>");
var alias = value.getItemsByXPath("/Item");
value.loadAML("<Item type='ReferenceRecord' id='B' />");
bool applyRejected = false;
bool insertionRejected = false;
try { alias.apply(); }
catch (InvalidOperationException) { applyRejected = true; }
try { alias.setPropertyItem("fixed_ref", value); }
catch (InvalidOperationException) { insertionRejected = true; }
if (!applyRejected || !insertionRejected || alias.getProperty("name") != "Detached")
{
    throw new Exception("A detached view performed a document-bound operation");
}
return this.getInnovator().newResult("Document views verified");`;

export const applyCollectionSelection = `
var query = this.newItem("ReferenceHolder", "get");
query.setAttribute("orderBy", "name");
var collection = query.apply();
if (collection.getItemCount() != 2) { throw new Exception("Expected two holders"); }
var selected = collection.getItemByIndex(0);
selected.setAction("update");
selected.setProperty("name", "Changed first");
return selected.apply();`;
