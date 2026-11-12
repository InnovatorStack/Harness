import type { AmlPropertyCondition } from "../../items/logical.js";
import { PredicateParser } from "../../queries/parser.js";
import { comparison, likePredicate, setPredicate } from "../../queries/predicates.js";
import { Comparison } from "../../queries/types.js";
import type { Predicate, QueryField } from "../../queries/types.js";
import { PlatformError } from "../errors.js";

export function propertyPredicate(field: QueryField, property: AmlPropertyCondition): Predicate {
    const condition = (property.attributes.condition ?? "eq").trim().toLowerCase();
    const value = property.attributes.is_null === "1" ? null : property.value;

    if (value === undefined) {
        throw new PlatformError("InvalidSelector", `Selector '${property.name}' needs a value.`);
    }

    if (condition === "is null" || condition === "is not null" || condition === "is") {
        const negate =
            condition === "is"
                ? String(value).trim().toLowerCase() === "not null"
                : condition === "is not null";

        if (
            condition === "is" &&
            !["null", "not null"].includes(String(value).trim().toLowerCase())
        ) {
            throw new PlatformError("UnsupportedCondition", "IS requires NULL or NOT NULL.");
        }

        return { kind: "null", field, negate };
    }

    if (condition === "in" || condition === "not in") {
        const values = new PredicateParser(String(value), () => field).scalarList();

        return setPredicate(field, values, condition === "not in");
    }

    if (condition === "between" || condition === "not between") {
        const [first, last] = new PredicateParser(String(value), () => field).range();
        const term: Predicate = {
            kind: "and",
            terms: [
                comparison(field, Comparison.GreaterOrEqual, first),
                comparison(field, Comparison.LessOrEqual, last),
            ],
        };

        return condition === "not between" ? { kind: "not", term } : term;
    }

    if (condition === "like" || condition === "not like") {
        return likePredicate(field, String(value), condition === "not like");
    }

    const operator = Object.values(Comparison).find((operator: string) => operator === condition);

    if (operator === undefined) {
        throw new PlatformError(
            "UnsupportedCondition",
            `Property condition '${condition}' is not implemented.`,
        );
    }

    if (value === null && (operator === Comparison.Equal || operator === Comparison.NotEqual)) {
        return { kind: "null", field, negate: operator === Comparison.NotEqual };
    }

    return comparison(field, operator, value);
}
