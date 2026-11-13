namespace InnovatorHarness.Managed;

internal sealed record ItemOrigin(object Owner, string Token);

// Invocation-local tokens identify pending XML nodes independently of business IDs.
internal sealed class RequestOrigins
{
    private sealed record Frame(ItemData? Item, LogicalData? Term, int Depth);

    private readonly object owner = new();
    private readonly HashSet<string> known = new(StringComparer.Ordinal);
    private string? scope;
    private int nextToken;

    internal OriginFrame Capture(ItemPayload payload)
    {
        string currentScope = scope
            ?? throw new InvalidOperationException("Missing Item origin scope.");
        ItemXml.Synchronize(payload);
        var result = new List<string>();
        var used = new HashSet<string>(StringComparer.Ordinal);

        foreach (ItemData item in Nodes(payload))
        {
            ItemOrigin? origin = item.Origin;

            if (origin is null || !ReferenceEquals(origin.Owner, owner))
            {
                string token = "m" + (++nextToken).ToString(
                    System.Globalization.CultureInfo.InvariantCulture);
                Remember(token);
                origin = new(owner, token);
                item.Origin = origin;
            }

            if (!used.Add(origin.Token))
            {
                throw new NotSupportedException("An Item origin occurs more than once.");
            }

            result.Add(origin.Token);
        }

        return new(currentScope, result);
    }

    internal void Apply(ItemPayload payload, OriginFrame? frame)
    {
        if (frame is null || !Guid.TryParseExact(frame.Scope, "D", out _)
            || (scope is not null && scope != frame.Scope))
        {
            throw new InvalidOperationException("Item origins belong to another invocation.");
        }

        var tokens = frame.Tokens;

        if (tokens is null || tokens.Count > WorkLimits.NodesMax)
        {
            throw new InvalidOperationException("Managed Item origins must be a bounded list.");
        }

        scope = frame.Scope;
        ItemXml.Synchronize(payload);
        var used = new HashSet<string>(StringComparer.Ordinal);
        int index = 0;

        foreach (ItemData item in Nodes(payload))
        {
            if (index >= tokens.Count)
            {
                throw new InvalidOperationException("Managed Item origins are incomplete.");
            }

            string token = tokens[index++];

            if (!ValidToken(token) || !used.Add(token)
                || (token[0] == 'm' && !known.Contains(token)))
            {
                throw new InvalidOperationException("Invalid or foreign managed Item origin.");
            }

            Remember(token);
            item.Origin = new(owner, token);
        }

        if (index != tokens.Count)
        {
            throw new InvalidOperationException("Managed Item origins do not match the payload.");
        }
    }

    private static bool ValidToken(string token)
    {
        return token.Length is >= 2 and <= 8 && token[0] is 'b' or 'm'
            && token[1] is >= '1' and <= '9'
            && int.TryParse(token.AsSpan(1), System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out int number)
            && number > 0 && number <= WorkLimits.NodesMax;
    }

    private void Remember(string token)
    {
        if (!known.Contains(token) && known.Count >= WorkLimits.NodesMax)
        {
            throw new NotSupportedException("Item origins exceed their invocation limit.");
        }

        known.Add(token);
    }

    // Keep this order aligned with items/origins.ts, including logical Item criteria.
    internal static IEnumerable<ItemData> Nodes(ItemPayload payload)
    {
        if (payload.Items.Count > WorkLimits.NodesMax)
        {
            throw new NotSupportedException("Item origins exceed their root limit.");
        }

        var pending = new Stack<Frame>();

        for (int index = payload.Items.Count - 1; index >= 0; index--)
        {
            pending.Push(new(payload.Items[index], null, 0));
        }

        int visited = 0;

        while (pending.Count > 0)
        {
            Frame frame = pending.Pop();

            if (++visited > WorkLimits.NodesMax || frame.Depth > WorkLimits.DepthMax
                || pending.Count > WorkLimits.NodesMax)
            {
                throw new NotSupportedException("Item origins exceed their traversal limit.");
            }

            if (frame.Term is { } term)
            {
                AppendLogical(term, frame.Depth, pending);
                continue;
            }

            ItemData item = frame.Item
                ?? throw new InvalidOperationException("An Item origin requires its source.");
            yield return item;
            AppendChildren(item, frame.Depth, pending);

            if (pending.Count > WorkLimits.NodesMax)
            {
                throw new NotSupportedException("Item origins exceed their pending node limit.");
            }
        }
    }

    private static void AppendChildren(ItemData item, int depth, Stack<Frame> pending)
    {
        long children = (long)item.Relationships.Count + item.PropertyItems.Count
            + (item.Logical?.Count ?? 0);

        if (children > WorkLimits.NodesMax - pending.Count)
        {
            throw new NotSupportedException("Item origins exceed their pending node limit.");
        }

        for (int index = item.Relationships.Count - 1; index >= 0; index--)
        {
            pending.Push(new(item.Relationships[index], null, depth + 1));
        }

        foreach (string name in item.PropertyItems.Keys.OrderByDescending(
            name => name, StringComparer.Ordinal))
        {
            pending.Push(new(item.PropertyItems[name], null, depth + 1));
        }

        var groups = item.Logical ?? new();

        for (int index = groups.Count - 1; index >= 0; index--)
        {
            pending.Push(new(null, groups[index], depth + 1));
        }
    }

    private static void AppendLogical(LogicalData term, int depth, Stack<Frame> pending)
    {
        if (term.Operator is not null)
        {
            var terms = term.Terms
                ?? throw new InvalidOperationException("A logical group needs terms.");

            if (terms.Count > WorkLimits.NodesMax - pending.Count)
            {
                throw new NotSupportedException("Item origins exceed their pending node limit.");
            }

            for (int index = terms.Count - 1; index >= 0; index--)
            {
                pending.Push(new(null, terms[index], depth + 1));
            }
        }
        else if (term.Item is { } item)
        {
            pending.Push(new(item, null, depth + 1));
        }
    }
}
