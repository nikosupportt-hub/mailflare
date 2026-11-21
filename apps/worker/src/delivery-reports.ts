// Mail the Worker could not handle as usual is recorded, and the daily cron
// mails each affected inbox one summary, only when there is something in it:
//
// - forwarded: re-sending failed, so the message was forwarded unchanged. It
//   arrived, but shows the sender's real address, and replying to it goes out
//   from the inbox's own address instead of through the alias.
// - undelivered: the message did not arrive at all.
//
// Mail turned away on purpose (disabled aliases, loops, sending limits) isn't
// an issue; neither is forwarding when re-sending isn't set up at all.

import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { createDb, type Db, schema } from "./db";
import { sendAccountEmail } from "./mailer";
import { decodeWords, getHeader, parseAddressList, type ParsedMessage } from "./mime";

export type IssueKind = "forwarded" | "undelivered";

/** Messages listed per kind in one summary; the rest are only counted. */
export const LISTED_PER_KIND = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long issues are kept, reported or not (without the EMAIL binding they never are). */
export const ISSUE_RETENTION_MS = 30 * DAY_MS;

/** One line of untrusted header text, at most `max` characters. */
const oneLine = (value: string, max: number) => {
    const line = value.replace(/[\s\p{Cc}]+/gu, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The From address and subject, from the parsed message or else Cloudflare's headers. */
function describe(message: ForwardableEmailMessage, parsed: ParsedMessage | null) {
    const header = (name: string) =>
        (parsed ? getHeader(parsed.headers, name) : message.headers.get(name)) ?? "";
    let sender = message.from;
    let subject = header("Subject");
    try {
        sender = parseAddressList(header("From"))[0]?.address || message.from;
        subject = decodeWords(subject);
    } catch {
        // Keep what there is: the summary only needs to recognize the message.
    }
    return { sender: oneLine(sender, 200), subject: oneLine(subject, 200) };
}

/** Records an issue; never throws, as it runs while mail is being handled. */
export async function recordIssue(
    db: Db,
    alias: { id: string; destination: { email: string } },
    kind: IssueKind,
    reason: string,
    message: ForwardableEmailMessage,
    parsed: ParsedMessage | null,
) {
    try {
        await db.insert(schema.deliveryIssues).values({
            aliasId: alias.id,
            destination: alias.destination.email,
            kind,
            reason: oneLine(reason, 500),
            ...describe(message, parsed),
        });
    } catch (error) {
        console.error(`Could not record a delivery issue: ${String(error)}`);
    }
}

type Row = {
    destination: string;
    kind: IssueKind;
    alias: string;
    sender: string;
    subject: string;
    reason: string;
    /** Seconds. */
    createdAt: number;
    total: number;
};

const SECTIONS: Record<IssueKind, { title: string; text: string }> = {
    undelivered: {
        title: "Not delivered",
        text: "These messages did not reach you.",
    },
    forwarded: {
        title: "Forwarded unchanged",
        text:
            "Mailflare could not rewrite these, so they reached you as they were sent: they show " +
            "the sender's real address, and a reply goes out from your own address, not from the alias.",
    },
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const utc = (seconds: number) =>
    `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The summary for one inbox; `rows` hold at most LISTED_PER_KIND per kind, newest first. */
export function formatReport(rows: Row[]): { subject: string; text: string } {
    const counts = { undelivered: 0, forwarded: 0 };
    for (const row of rows) counts[row.kind] = row.total;

    const subject = [
        counts.undelivered && `${plural(counts.undelivered, "message")} not delivered`,
        counts.forwarded && `${plural(counts.forwarded, "message")} forwarded unchanged`,
    ]
        .filter(Boolean)
        .join(", ");

    const lines = ["Since the last summary, Mailflare could not handle some mail as usual.", ""];
    for (const kind of ["undelivered", "forwarded"] as const) {
        const listed = rows.filter((row) => row.kind === kind);
        if (!listed.length) continue;
        lines.push(`${SECTIONS[kind].title} (${counts[kind]})`, SECTIONS[kind].text, "");
        for (const row of listed) {
            lines.push(
                `- ${utc(row.createdAt)}, to ${row.alias}, from ${row.sender || "(no sender)"}`,
                `  Subject: ${row.subject || "(none)"}`,
                `  Reason: ${row.reason}`,
            );
        }
        if (counts[kind] > listed.length) {
            lines.push(`- and ${counts[kind] - listed.length} more`);
        }
        lines.push("");
    }
    lines.push("If the same reason keeps coming up, the Worker's email setup may need a look.");
    return { subject: `Mailflare: ${subject}`, text: lines.join("\n") };
}

/**
 * Sends each inbox with issues since its last summary a new one. An inbox
 * whose summary fails to send keeps its issues for the next run.
 */
export async function sendDeliveryReports(env: Env, now = new Date()) {
    const db = createDb(env.DB);
    const { deliveryIssues } = schema;
    // Whole seconds before now, so issues recorded during the run wait for the next.
    const cutoff = new Date(Math.floor(now.getTime() / 1000) * 1000);

    // The newest few per inbox and kind, with the total of each.
    const rows = await db.all<Row>(sql`
        SELECT * FROM (
            SELECT i.destination, i.kind, a.address AS alias,
                i.sender, i.subject, i.reason, i.created_at AS createdAt,
                COUNT(*) OVER (PARTITION BY i.destination, i.kind) AS total,
                ROW_NUMBER() OVER (
                    PARTITION BY i.destination, i.kind ORDER BY i.created_at DESC, i.rowid DESC
                ) AS n
            FROM ${deliveryIssues} i
            JOIN ${schema.aliases} a ON a.id = i.alias_id
            WHERE i.reported_at IS NULL AND i.created_at < ${Math.floor(cutoff.getTime() / 1000)}
        ) WHERE n <= ${LISTED_PER_KIND}
        ORDER BY destination, createdAt DESC
    `);
    if (rows.length === 0) return;
    if (!env.EMAIL) {
        console.warn("Delivery issues to report, but the EMAIL binding is not set up");
        return;
    }

    // Each issue belongs to the inbox it was recorded for, whatever the alias does since.
    const byInbox = Map.groupBy(rows, (row) => row.destination);
    for (const [destination, inboxRows] of byInbox) {
        try {
            await sendAccountEmail(env, db, { to: destination, ...formatReport(inboxRows) });
        } catch (error) {
            console.error(`Could not send a delivery summary: ${String(error)}`);
            continue;
        }
        await db
            .update(deliveryIssues)
            .set({ reportedAt: now })
            .where(
                and(
                    isNull(deliveryIssues.reportedAt),
                    lt(deliveryIssues.createdAt, cutoff),
                    eq(deliveryIssues.destination, destination),
                ),
            );
    }
}
