import { referenceMethod } from "./references.js";

export function restrictedMethod(name: string, code: string): string {
    return referenceMethod(name, code).replace(
        "</method_type>",
        "</method_type><execution_allowed_to>SEC_PUBLISHERS</execution_allowed_to>",
    );
}

export const noPublisherGrant = `
    var publishers = Aras.Server.Security.Identity.GetByName("Test publishers");
    if (CCO.Permissions.IdentityListHasId(CCO.Permissions.IdentitiesList, publishers.Id)) {
        throw new Exception("Method NoCheck must not grant an Identity");
    }
`;
