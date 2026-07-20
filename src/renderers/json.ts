import type { ReviewRenderer } from "./registry.js";

export const jsonReviewRenderer: ReviewRenderer = {
    id: "json",
    mediaType: "application/json",
    extension: "json",
    render: (report) => `${JSON.stringify(report, null, 2)}\n`,
};
