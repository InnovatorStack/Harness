using System.Text;

namespace InnovatorHarness.Managed;

/** Read bounded UTF-8 frames in blocks; Console.In.Read locks for every character. */
internal sealed class ProtocolInput(Stream input) : IDisposable
{
    private readonly byte[] buffer = new byte[16 * 1024];
    private readonly MemoryStream line = new();
    private readonly UTF8Encoding encoding = new(false, true);
    private int offset;
    private int length;

    internal string? ReadLine()
    {
        while (true)
        {
            if (offset == length)
            {
                length = input.Read(buffer);
                offset = 0;

                if (length == 0)
                {
                    if (line.Length != 0)
                    {
                        throw new EndOfStreamException("Bun stopped inside a message.");
                    }

                    return null;
                }
            }

            var available = buffer.AsSpan(offset, length - offset);
            var newline = available.IndexOf((byte)'\n');
            var count = available.Length;

            if (newline >= 0)
            {
                count = newline;
            }

            if (line.Length + count > WorkLimits.MessageBytesMax)
            {
                throw new InvalidOperationException("Bun message exceeds its byte limit.");
            }

            line.Write(available[..count]);
            offset += count;

            if (newline >= 0)
            {
                offset += 1;
                var text = encoding.GetString(line.GetBuffer(), 0, checked((int)line.Length));
                line.SetLength(0);

                return text;
            }
        }
    }

    public void Dispose()
    {
        line.Dispose();
        input.Dispose();
    }
}
