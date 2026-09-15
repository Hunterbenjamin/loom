import { z } from "zod";

const issueLink = z.string().regex(/^loom:\/\/issue\/(t-[a-f0-9]{8})$/);

export function issueFromLink(value: string): string | null {
  return issueLink.safeParse(value).success
    ? value.slice("loom://issue/".length)
    : null;
}
