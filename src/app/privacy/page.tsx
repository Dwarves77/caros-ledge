// Ported from old_repo/src/app/privacy/page.tsx (lines 1-380)
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Privacy Policy · Caro's Ledge",
  description: "Privacy Policy for Caro's Ledge, how we collect, use, store, and protect personal information.",
  robots: { index: true, follow: true },
};

// The policy copy is the approved text, unchanged until counsel rules on the processor list. The page carries no <main> of its own: the shell supplies the page's single main landmark, so this page renders a div (the old page nested a second main).
export default function PrivacyPolicyPage() {
  return (
    <div className="cl-privacy">
      <article className="cl-privacy-article">
        <h1 className="cl-privacy-title">Privacy Policy</h1>
         <p className="cl-privacy-updated">
          Last updated: April 30, 2026
        </p>

        <Section title="Introduction">
          <P>
            Caro&apos;s Ledge (&quot;we&quot;, &quot;our&quot;, &quot;the
            platform&quot;) is a freight sustainability intelligence platform
            operated by Pet Pursuit LLC. This Privacy Policy explains how we
            collect, use, store, and protect information when you use our
            services.
          </P>
          <P>
            We process personal data in accordance with applicable laws
            including the EU General Data Protection Regulation (GDPR), the UK
            GDPR, and the California Consumer Privacy Act (CCPA).
          </P>
        </Section>

        <Section title="Information We Collect">
          <H3>Information You Provide</H3>
          <UL>
            <li>Account information: name, email address, company affiliation, role</li>
            <li>
              Workspace profile: organization name, freight sectors, transport
              modes, jurisdictions of interest
            </li>
            <li>
              Authentication credentials: passwords (stored as cryptographic
              hashes only)
            </li>
            <li>
              OAuth identifiers when you sign in via LinkedIn or other
              providers
            </li>
          </UL>

          <H3>Information We Collect Automatically</H3>
          <UL>
            <li>
              Usage data: pages viewed, features accessed, regulations queried,
              intersection patterns explored
            </li>
            <li>
              Technical data: IP address, browser type, device information,
              session timestamps
            </li>
            <li>
              Cookies and similar tracking technologies (see Cookies section
              below)
            </li>
          </UL>

          <H3>Information from Third Parties</H3>
          <UL>
            <li>
              Profile information from OAuth providers (LinkedIn) when you sign
              in: name, email, profile photo, professional title
            </li>
            <li>
              Public regulatory data ingested from official sources (does not
              include personal data)
            </li>
          </UL>
        </Section>

        <Section title="How We Use Information">
          <P>We use the information we collect to:</P>
          <UL>
            <li>Provide, operate, and maintain the platform</li>
            <li>Authenticate users and manage accounts</li>
            <li>
              Personalize your experience based on workspace profile and
              freight sectors
            </li>
            <li>
              Generate intelligence summaries and regulatory analyses relevant
              to your operations
            </li>
            <li>
              Communicate with you about platform updates, new regulations, and
              service announcements
            </li>
            <li>
              Detect, prevent, and address technical issues, security
              incidents, and fraud
            </li>
            <li>Comply with legal obligations</li>
            <li>
              Improve our services through aggregated, anonymized analytics
            </li>
          </UL>
        </Section>

        <Section title="Legal Bases for Processing (GDPR)">
          <P>
            Where GDPR applies, we process personal data on the following legal
            bases:
          </P>
          <UL>
            <li>
              Performance of a contract: to provide the services you&apos;ve
              signed up for
            </li>
            <li>
              Legitimate interests: to operate, secure, and improve our
              platform
            </li>
            <li>Legal obligations: to comply with applicable laws</li>
            <li>
              Consent: where required, such as for marketing communications
            </li>
          </UL>
        </Section>

        <Section title="Information Sharing">
          <P>
            We do not sell personal information. We share information only as
            described below:
          </P>

          <H3>Service Providers</H3>
          <P>
            We share information with vendors who help us operate the platform,
            including:
          </P>
          <UL>
            <li>Supabase (database and authentication infrastructure)</li>
            <li>Vercel (hosting and content delivery)</li>
            <li>Anthropic (AI processing for intelligence generation)</li>
            <li>LinkedIn (OAuth authentication)</li>
            <li>Browserless (web content rendering for source ingestion)</li>
            <li>Stripe (payment processing, when applicable)</li>
          </UL>
          <P>
            These providers are contractually bound to protect your information
            and use it only for the purposes we specify.
          </P>

          <H3>Legal Requirements</H3>
          <P>
            We may disclose information if required by law, court order, or
            government request, or to protect our rights, property, or safety,
            or that of our users or others.
          </P>

          <H3>Business Transfers</H3>
          <P>
            If Pet Pursuit LLC is involved in a merger, acquisition, or sale of
            assets, your information may be transferred. We will notify you and
            provide options before your information becomes subject to a
            different privacy policy.
          </P>
        </Section>

        <Section title="Data Retention">
          <P>
            We retain personal information for as long as your account is
            active and as needed to provide services. After account deletion,
            we retain certain information as required by law or for legitimate
            business purposes (such as fraud prevention or legal compliance),
            typically not exceeding 7 years.
          </P>
          <P>
            Aggregated, anonymized data may be retained indefinitely for
            analytical purposes.
          </P>
        </Section>

        <Section title="Your Rights">
          <P>
            Depending on your location, you may have the following rights:
          </P>
          <UL>
            <li>
              Access: request a copy of personal information we hold about you
            </li>
            <li>Correction: request correction of inaccurate information</li>
            <li>
              Deletion: request deletion of your information (&quot;right to be
              forgotten&quot;)
            </li>
            <li>
              Portability: receive your information in a structured,
              machine-readable format
            </li>
            <li>Objection: object to certain types of processing</li>
            <li>
              Restriction: request limitation of how we process your information
            </li>
            <li>Withdrawal of consent: where processing is based on consent</li>
            <li>Lodge a complaint with a supervisory authority</li>
          </UL>
          <P>
            To exercise these rights, contact us at the address below. We will
            respond within 30 days.
          </P>

          <H3>California Residents (CCPA)</H3>
          <P>
            California residents have specific rights including the right to
            know what personal information is collected, the right to delete
            personal information, and the right to opt out of the sale of
            personal information. We do not sell personal information.
          </P>
        </Section>

        <Section title="International Data Transfers">
          <P>
            Caro&apos;s Ledge operates globally. Your information may be
            transferred to and processed in countries other than your own,
            including the United States. Where required, we use appropriate
            safeguards such as Standard Contractual Clauses to protect your
            information during international transfers.
          </P>
        </Section>

        <Section title="Data Security">
          <P>
            We implement reasonable technical and organizational security
            measures including:
          </P>
          <UL>
            <li>Encryption of data in transit (TLS) and at rest</li>
            <li>Access controls and authentication requirements</li>
            <li>Regular security audits and updates</li>
            <li>Incident response procedures</li>
          </UL>
          <P>No system is completely secure. We cannot guarantee absolute security.</P>
        </Section>

        <Section title="Cookies and Tracking Technologies">
          <P>We use cookies and similar technologies to:</P>
          <UL>
            <li>Maintain your authenticated session</li>
            <li>Remember your preferences</li>
            <li>Understand how the platform is used</li>
            <li>Improve functionality and performance</li>
          </UL>
          <P>
            You can control cookies through your browser settings. Disabling
            cookies may affect platform functionality.
          </P>
          <P>We do not use third-party advertising cookies.</P>
        </Section>

        <Section title="Children's Privacy">
          <P>
            Caro&apos;s Ledge is a B2B platform and is not directed to children
            under 16. We do not knowingly collect personal information from
            children. If you believe we have collected information from a
            child, contact us and we will delete it.
          </P>
        </Section>

        <Section title="Third-Party Links">
          <P>
            The platform may contain links to third-party websites including
            regulatory sources, official gazettes, and industry publications.
            Their privacy practices are governed by their own policies. We are
            not responsible for the content or privacy practices of third-party
            sites.
          </P>
        </Section>

        <Section title="Changes to This Policy">
          <P>
            We may update this Privacy Policy. We will notify you of material
            changes by email or through the platform. The &quot;Last
            updated&quot; date at the top reflects the most recent revision.
          </P>
        </Section>

        <Section title="Contact">
          <P>Questions about this Privacy Policy or our data practices:</P>
          <P>
            <strong>Pet Pursuit LLC</strong>
            <br />
            50 Falls Road, Falls Village, CT 06031, USA
            <br />
            Privacy contact:{" "}
            <a href="mailto:privacy@carosledge.com" className="cl-privacy-link">
              privacy@carosledge.com
            </a>
          </P>
          <P>
            For EU/UK data subjects, our representative is: Caro&apos;s Ledge
            is currently in early access. EU/UK GDPR Article 27 representative
            will be designated upon onboarding of EU/UK data subjects.
          </P>
        </Section>

        <Section title="Data Protection Officer">
          <P>
            Pet Pursuit LLC has not appointed a dedicated Data Protection
            Officer. Privacy inquiries should be directed to{" "}
            <a href="mailto:privacy@carosledge.com" className="cl-privacy-link">
              privacy@carosledge.com
            </a>
            .
          </P>
        </Section>
      </article>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="cl-privacy-section">
    <h2 className="cl-privacy-h2">{title}</h2>
    <div className="cl-privacy-body">{children}</div>
  </section>
);
const H3 = ({ children }: { children: ReactNode }) => <h3 className="cl-privacy-h3">{children}</h3>;
const P = ({ children }: { children: ReactNode }) => <p className="cl-privacy-p">{children}</p>;
const UL = ({ children }: { children: ReactNode }) => <ul className="cl-privacy-ul">{children}</ul>;
