import type { Item } from "../items/item.js";

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | {
          readonly [name: string]: JsonValue;
      };

export type MockValue =
    | null
    | boolean
    | number
    | string
    | {
          readonly [name: string]: MockValue;
      };

export type MockResponse =
    | Item
    | {
          readonly json: JsonValue;
      }
    | {
          readonly text: string;
      }
    | {
          readonly aml: string;
      }
    | {
          readonly error: string;
          readonly code?: string;
      };

interface MockOptions {
    readonly when?: Readonly<Record<string, MockValue>>;
    readonly response: string | MockResponse;
}

export interface MethodMock extends MockOptions {
    readonly method: string;
    readonly sql?: never;
}

/** A named SQL procedure, or an inline query selected by its calling Method. */
export interface SqlMock extends MockOptions {
    readonly sql: string | true;
    readonly method?: never;
}

export type Mock = MethodMock | SqlMock;

export type MockInput = string | Mock;
