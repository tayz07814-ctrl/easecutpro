// Legal pages (Terms / Privacy / Refund) — dark shell matching the landing.
// Content is a practical draft tailored to Easecut (JAYZE TECHNOLOGIES),
// the on-device media model, and Paddle as Merchant of Record. It is not legal
// advice — worth a lawyer's review, especially the Pakistan-specific clauses.
import { useEffect } from 'react'

const ENTITY = 'JAYZE TECHNOLOGIES'
const SUPPORT = 'support@easecutpro.com'
const UPDATED = 'Last updated: 21 July 2026'

type Block = string | { ul: string[] }
interface Section {
  h: string
  body: Block[]
}
interface Doc {
  title: string
  intro: string
  sections: Section[]
}

const DOCS: Record<'terms' | 'privacy' | 'refund', Doc> = {
  terms: {
    title: 'Terms of Service',
    intro:
      `These Terms of Service ("Terms") govern your use of Easecut (the "Service"), operated by ${ENTITY} ` +
      `("we", "us", "our") at easecutpro.com. By creating an account or using the Service, you agree to these Terms.`,
    sections: [
      {
        h: '1. The Service',
        body: [
          'Easecut is an AI-assisted video editing tool that helps creators detect retakes, false starts, filler, repeated lines, and long pauses in their footage, review the suggestions, and export a tightened cut.',
          'Easecut only suggests edits. Nothing is applied to your footage until you review and approve it. You are responsible for the final exported video.'
        ]
      },
      {
        h: '2. Accounts',
        body: [
          'You must provide accurate information and keep your login credentials secure. You are responsible for all activity under your account.',
          'You must be at least 18 years old, or the age of majority in your jurisdiction, to use the Service.'
        ]
      },
      {
        h: '3. Subscriptions, billing & Merchant of Record',
        body: [
          'Easecut offers paid subscription plans (Starter, Pro, and Unlimited) billed on a recurring monthly basis in US dollars. Applicable taxes may be added.',
          'Our order process and payments are handled by Paddle.com (Paddle.com Market Ltd), which is the Merchant of Record and authorised reseller for all purchases of the Service. Paddle handles billing, payment processing, the issuing of invoices, and related billing support and refunds. By purchasing a subscription you also agree to Paddle’s buyer terms and conditions.',
          'Subscriptions renew automatically until cancelled. You can cancel at any time; your access continues until the end of the paid billing period. Refunds are governed by our Refund Policy.'
        ]
      },
      {
        h: '4. Your content',
        body: [
          'You retain all rights to the videos, audio, transcripts, and edits you upload or create ("Your Content"). We claim no ownership of it.',
          'You grant us a limited licence to process Your Content solely to operate and provide the Service to you.',
          'Your source video files are processed locally on your device and are not uploaded to our servers. Only the small extracted audio needed for transcription is uploaded to a private temporary location and deleted immediately after processing (see our Privacy Policy).'
        ]
      },
      {
        h: '5. Acceptable use',
        body: [
          'You agree not to:',
          {
            ul: [
              'use the Service for unlawful purposes or to process content you do not have the rights to;',
              'infringe the intellectual property, privacy, or other rights of any person;',
              'attempt to reverse engineer, resell, or abuse the Service or its infrastructure;',
              'interfere with or place an unreasonable load on the Service.'
            ]
          }
        ]
      },
      {
        h: '6. Intellectual property',
        body: [
          `The Service, including its software, models, design, and the Easecut brand, is owned by ${ENTITY} and its licensors and is protected by applicable laws.`
        ]
      },
      {
        h: '7. Disclaimers',
        body: [
          'The Service is provided "as is" and "as available" without warranties of any kind. AI-generated suggestions may be inaccurate or incomplete, and you are responsible for reviewing the result before publishing.'
        ]
      },
      {
        h: '8. Limitation of liability',
        body: [
          'To the maximum extent permitted by law, we are not liable for any indirect, incidental, or consequential damages, or loss of data or profits. Our total liability for any claim is limited to the amount you paid us in the twelve months before the claim.'
        ]
      },
      {
        h: '9. Termination',
        body: [
          'We may suspend or terminate your access if you breach these Terms. You may stop using the Service and delete your account at any time.'
        ]
      },
      {
        h: '10. Changes to these Terms',
        body: [
          'We may update these Terms from time to time. Material changes will be reflected by the "last updated" date, and your continued use of the Service constitutes acceptance.'
        ]
      },
      {
        h: '11. Governing law',
        body: ['These Terms are governed by the laws of Pakistan, without regard to conflict-of-law principles.']
      },
      {
        h: '12. Contact',
        body: [`Questions about these Terms? Contact ${ENTITY} at ${SUPPORT}.`]
      }
    ]
  },
  privacy: {
    title: 'Privacy Policy',
    intro:
      `This Privacy Policy explains how ${ENTITY} ("we", "us", "our") collects, uses, and protects your information ` +
      `when you use Easecut at easecutpro.com.`,
    sections: [
      {
        h: '1. Information we collect',
        body: [
          {
            ul: [
              'Account information: your email address and a securely hashed password.',
              'Projects: the edit documents and transcripts you save, so your work syncs to your account across devices.',
              'Audio for transcription: the extracted audio track of a clip, uploaded temporarily to generate a transcript.',
              'Usage and technical data: basic logs and device/browser information used for security and reliability.',
              'Payment information: handled entirely by Paddle. We do not receive or store your card details.'
            ]
          }
        ]
      },
      {
        h: '2. Your video stays on your device',
        body: [
          'Your source video files are processed locally in your browser and are never uploaded to our servers. Only the extracted audio required for transcription is uploaded to a private, temporary location and is deleted immediately after the transcript is produced.'
        ]
      },
      {
        h: '3. How we use your information',
        body: [
          {
            ul: [
              'to provide, maintain, and improve the Service;',
              'to generate transcripts and AI editing suggestions;',
              'to manage your account and provide customer support;',
              'to keep the Service secure and to comply with legal obligations.'
            ]
          }
        ]
      },
      {
        h: '4. Service providers',
        body: [
          'We use trusted third parties that process data only to provide their function to us:',
          {
            ul: [
              'Cloud infrastructure, authentication, and database providers — to host the Service and store your account and projects;',
              'Paddle — payment processing, as our Merchant of Record;',
              'Speech-to-text providers — to convert the extracted audio into a transcript;',
              'AI/model providers — to generate the editing suggestions.'
            ]
          },
          'We work with a small number of vetted sub-processors. A current list is available on request at ' +
            `${SUPPORT}.`
        ]
      },
      {
        h: '5. Data retention',
        body: [
          'We keep your account and project data while your account is active. Extracted audio is deleted right after transcription. You can delete individual projects, or your entire account, at any time.'
        ]
      },
      {
        h: '6. Security',
        body: [
          'We use measures such as row-level security and encryption in transit to protect your data. No method of storage or transmission is 100% secure, but we work to protect your information.'
        ]
      },
      {
        h: '7. Your rights',
        body: [`You may access, correct, export, or delete your personal data. To exercise these rights, contact us at ${SUPPORT}.`]
      },
      {
        h: '8. Cookies & local storage',
        body: ['We use cookies and browser storage to keep you signed in and to remember your preferences.']
      },
      {
        h: '9. Children',
        body: ['The Service is not directed to, and may not be used by, anyone under 18.']
      },
      {
        h: '10. International processing',
        body: [
          'Your information may be processed on servers located outside your country, including by the service providers listed above.'
        ]
      },
      {
        h: '11. Changes & contact',
        body: [
          `We may update this policy; changes are reflected by the "last updated" date. Questions? Contact ${ENTITY} at ${SUPPORT}.`
        ]
      }
    ]
  },
  refund: {
    title: 'Refund Policy',
    intro:
      `This Refund Policy applies to Easecut subscriptions operated by ${ENTITY}. Payments and refunds are processed ` +
      `by Paddle.com, our reseller and Merchant of Record.`,
    sections: [
      {
        h: '1. 14-day money-back guarantee',
        body: [
          `If you are not satisfied with Easecut, you may request a full refund within 14 days of your initial purchase by emailing ${SUPPORT} (or by contacting Paddle). We will refund your first payment, no questions asked.`
        ]
      },
      {
        h: '2. Renewals',
        body: [
          'Subscription renewal payments are generally non-refundable. That said, if you were charged for a renewal you did not intend to keep, contact us promptly — we review reasonable cases (such as an accidental renewal) individually and in good faith.'
        ]
      },
      {
        h: '3. Cancellation',
        body: [
          'You can cancel your subscription at any time from your account or by contacting us. When you cancel, you keep access until the end of your current billing period. We do not provide partial-period refunds except where required by law.'
        ]
      },
      {
        h: '4. How to request a refund',
        body: [`Email ${SUPPORT} from your account email with your order details, and we (or Paddle) will process eligible refunds to your original payment method.`]
      },
      {
        h: '5. Contact',
        body: [`${ENTITY} — ${SUPPORT}`]
      }
    ]
  }
}

export default function LegalPage({
  kind,
  onNavigate
}: {
  kind: 'terms' | 'privacy' | 'refund'
  onNavigate: (path: string) => void
}): JSX.Element {
  useEffect(() => {
    document.body.classList.add('ec-landing-body')
    window.scrollTo(0, 0)
    return () => document.body.classList.remove('ec-landing-body')
  }, [])

  const doc = DOCS[kind]

  return (
    <div className="ec-landing" style={{ minHeight: '100vh', background: '#08080A', color: '#F5F5F7' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '110px 32px 96px' }}>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault()
            onNavigate('/')
          }}
          style={{ color: '#9A9AA6', fontSize: 14.5, cursor: 'pointer' }}
        >
          ← Back to home
        </a>
        <h1
          style={{
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
            fontSize: 'clamp(30px,4vw,44px)',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            margin: '22px 0 6px'
          }}
        >
          {doc.title}
        </h1>
        <p style={{ color: '#5A5A64', fontSize: 13.5 }}>{UPDATED}</p>
        <p style={{ marginTop: 22, color: '#C7C7D0', fontSize: 16, lineHeight: 1.7 }}>{doc.intro}</p>

        {doc.sections.map((s) => (
          <section key={s.h} style={{ marginTop: 34 }}>
            <h2
              style={{
                fontFamily: "'Space Grotesk', system-ui, sans-serif",
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                color: '#EDEDF2'
              }}
            >
              {s.h}
            </h2>
            {s.body.map((b, i) =>
              typeof b === 'string' ? (
                <p key={i} style={{ marginTop: 12, color: '#9A9AA6', fontSize: 15.5, lineHeight: 1.7 }}>
                  {b}
                </p>
              ) : (
                <ul key={i} style={{ marginTop: 12, paddingLeft: 20, color: '#9A9AA6', fontSize: 15.5, lineHeight: 1.7 }}>
                  {b.ul.map((li, j) => (
                    <li key={j} style={{ marginTop: 6 }}>
                      {li}
                    </li>
                  ))}
                </ul>
              )
            )}
          </section>
        ))}

        <p style={{ marginTop: 44, paddingTop: 22, borderTop: '1px solid rgba(255,255,255,0.08)', color: '#5A5A64', fontSize: 13.5 }}>
          © 2026 {ENTITY}. All rights reserved.
        </p>
      </div>
    </div>
  )
}
