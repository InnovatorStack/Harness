using System.Globalization;

namespace InnovatorHarness.Managed;

public sealed class ErrorLookup(Remote remote)
{
    public string Lookup(string key, params object?[] arguments)
    {
        var query = new Innovator(remote).newItem("UserMessage", "get");
        query.setAttribute("select", "name,text");
        query.setProperty("name", key);
        var result = query.apply();

        if (result.isError() || result.getItemCount() != 1)
        {
            remote.Unsupported($"Import one UserMessage for error key '{key}'.");
        }

        string template = result.getProperty("text");

        if (template.Length == 0)
        {
            remote.Unsupported($"UserMessage '{key}' has no imported message text.");
        }

        return string.Format(CultureInfo.InvariantCulture, template, arguments);
    }
}
