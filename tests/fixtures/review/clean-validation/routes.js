export async function accountRoute(request, store, authorization) {
    const accountId = parseAccountId(request.params.accountId);
    await authorization.requireAccountAccess(request.user, accountId);
    return { status: 200, body: await store.load(accountId) };
}

function parseAccountId(value) {
    if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value)) throw new Error("invalid account ID");
    return value;
}
