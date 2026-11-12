import { queryTextMax } from "./types.js";

export enum TokenKind {
    Word = "word",
    Identifier = "identifier",
    String = "string",
    Number = "number",
    Symbol = "symbol",
}

export interface Token {
    readonly kind: TokenKind;
    readonly value: string;
    readonly position: number;
}

export function tokenize(text: string): readonly Token[] {
    if (text.length > queryTextMax) {
        throw new TypeError("Query text exceeds its input limit.");
    }

    const tokens: Token[] = [];
    let offset = 0;

    while (offset < text.length) {
        const character = text[offset];

        if (!character) {
            throw new Error("A query character must exist before the text boundary.");
        }

        if (/\s/u.test(character)) {
            offset += 1;
            continue;
        }

        const token = readToken(text, offset);
        tokens.push(token.token);
        offset = token.end;

        if (tokens.length > 20_000) {
            throw new TypeError("Query token limit exceeded.");
        }
    }

    return tokens;
}

function readToken(text: string, offset: number): { readonly token: Token; readonly end: number } {
    const character = text[offset];

    if (character === "'" || character === "[") {
        return quoted(text, offset, character);
    }

    const rest = text.slice(offset);
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(rest)?.[0];
    const word = /^[A-Za-z_][A-Za-z_\d$]*/u.exec(rest)?.[0];
    const symbol = /^(?:<>|!=|<=|>=|[=<>(),.])/u.exec(rest)?.[0];
    let token: Token;

    if (number) {
        token = { kind: TokenKind.Number, value: number, position: offset };
    } else if (word) {
        token = { kind: TokenKind.Word, value: word, position: offset };
    } else if (symbol) {
        token = { kind: TokenKind.Symbol, value: symbol, position: offset };
    } else {
        throw new TypeError(`Unsupported query syntax at position ${offset + 1}.`);
    }

    return { token, end: offset + token.value.length };
}

function quoted(text: string, start: number, opening: "'" | "[") {
    const closing = opening === "[" ? "]" : "'";
    const parts: string[] = [];
    let offset = start + 1;

    while (offset < text.length) {
        const character = text[offset];

        if (character === closing) {
            if (text[offset + 1] === closing) {
                parts.push(closing);
                offset += 2;
                continue;
            }

            return {
                token: {
                    kind: opening === "[" ? TokenKind.Identifier : TokenKind.String,
                    value: parts.join(""),
                    position: start,
                },
                end: offset + 1,
            };
        }

        if (character === undefined) {
            throw new Error("Quoted query text must remain inside its input boundary.");
        }

        parts.push(character);
        offset += 1;
    }

    throw new TypeError(`Unterminated query literal at position ${start + 1}.`);
}
