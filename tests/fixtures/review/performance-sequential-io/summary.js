export async function loadSummary(client) {
    const profile = await client.profile();
    const orders = await client.orders();
    return { profile, orders };
}
