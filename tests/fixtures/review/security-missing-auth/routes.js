export async function accountRoute(request, store) {
    const account = await store.load(request.params.accountId);
    return { status: 200, body: account };
}
