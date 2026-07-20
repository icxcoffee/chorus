export async function internalHandler(request, service) {
    return await service.lookup(request.subject);
}
