// New in R2c: no old counterpart (the old tree sent a browser identity and said nothing about what it collects).
// The page the declared user agent points to: CarosLedge/1.0 (+https://carosledge.com/bot). It states what is collected, how often, who to write to, and how a publisher opts out.
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "CarosLedge crawler · Caro's Ledge",
  description: "What the CarosLedge crawler collects, how often, who to contact, and how to opt out.",
  robots: { index: true, follow: true },
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="cl-privacy-section">
    <h2 className="cl-privacy-h2">{title}</h2>
    <div className="cl-privacy-body">{children}</div>
  </section>
);

/** The contact address is a deployment setting (BOT_CONTACT_EMAIL), never typed into the page; an unset one is stated, not hidden. */
export default function BotPage() {
  const contact = process.env.BOT_CONTACT_EMAIL?.trim() || null;
  return (
    <div className="cl-privacy">
      <article className="cl-privacy-article">
        <h1 className="cl-privacy-title">The CarosLedge crawler</h1>
        <p className="cl-privacy-updated">User agent: CarosLedge/1.0 (+https://carosledge.com/bot)</p>
        <Section title="What it collects">
          <p className="cl-privacy-p">
            Caro&apos;s Ledge is a freight sustainability intelligence service. The crawler reads publicly published laws, regulations, standards, guidance and market statistics from official and trade publishers, and keeps the text
            of each document it reads so the service can show what it says and where it came from. It does not log in, fill in forms, read pages behind a paywall or a login, or collect personal data.
          </p>
        </Section>
        <Section title="How it behaves">
          <ul className="cl-privacy-ul">
            <li>It sends one declared identity, the user agent above, and never presents itself as a person&apos;s browser.</li>
            <li>It reads your robots.txt first and honours it: the group named CarosLedge, else the * group, with the longest matching rule and Allow winning a tie, and your Crawl-delay when it is longer than one second.</li>
            <li>It makes at most one request per second to a host, and prefers a feed, a sitemap or an API you publish to fetching pages.</li>
            <li>A refusal (403, 429, a challenge page) is final for the crawler: it does not retry under another declared or disguised identity.</li>
            <li>
              Where your robots.txt allows the page and no login, paywall or CAPTCHA is involved, a page the crawler was refused may then be read once in an ordinary web browser, one page every few seconds, as a
              person reading it would. That browser never solves a CAPTCHA and never enters a login. If your site publishes a feed or an API, those are used first.
            </li>
          </ul>
        </Section>
        <Section title="How often">
          <p className="cl-privacy-p">The crawler runs on a schedule, never continuously. A page is re-read only when its sitemap date, a feed entry or a conditional request shows it changed, and a document that has not changed is not stored again.</p>
        </Section>
        <Section title="Opting out">
          <p className="cl-privacy-p">Add a group to your robots.txt and the crawler stops reading the paths it disallows:</p>
          <pre className="cl-privacy-p">{"User-agent: CarosLedge\nDisallow: /"}</pre>
          <p className="cl-privacy-p">You can also write to us and we will remove what was collected from your site.</p>
        </Section>
        <Section title="Contact">
          {contact ? (
            <p className="cl-privacy-p">
              Questions, access arrangements and removal requests: <a className="cl-privacy-link" href={`mailto:${contact}`}>{contact}</a>
            </p>
          ) : (
            <p className="cl-privacy-p">The contact address for the crawler has not been set for this deployment yet. Until it is, write to the address on the privacy page.</p>
          )}
        </Section>
      </article>
    </div>
  );
}
