import { app } from "./api";
import { cleanup } from "./cleanup";
import { sendDeliveryReports } from "./delivery-reports";
import { handleEmail } from "./email";

export default {
    fetch: app.fetch,
    email: handleEmail,
    scheduled: (_controller, env, ctx) => {
        ctx.waitUntil(cleanup(env));
        ctx.waitUntil(sendDeliveryReports(env));
    },
} satisfies ExportedHandler<Env>;
