package smtpd

import (
	"strings"
	"testing"
)

func TestBuildFindsBccAndParts(t *testing.T) {
	raw := strings.ReplaceAll(`From: "Chris" <Chris@Example.com>
To: jo@example.org
Cc: Sam <sam@example.org>
Subject: =?utf-8?q?Caf=C3=A9_plans?=
Message-ID: <m1@example.com>
In-Reply-To: <earlier@example.org>
References: <first@example.org> <earlier@example.org>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8

Hello
--b2
Content-Type: text/html; charset=utf-8

<p>Hello</p>
--b2--
--b1
Content-Type: application/pdf; name="plan.pdf"
Content-Disposition: attachment; filename="plan.pdf"
Content-Transfer-Encoding: base64

JVBERi0=
--b1--
`, "\n", "\r\n")
	m, id, err := Build([]byte(raw), "chris@example.com", []string{"jo@example.org", "sam@example.org", "hidden@example.org"})
	if err != nil {
		t.Fatal(err)
	}
	if id != "m1@example.com" {
		t.Errorf("message id %q", id)
	}
	if m.From.Email != "chris@example.com" || m.From.Name != "Chris" {
		t.Errorf("from %+v", m.From)
	}
	if m.Subject != "Café plans" {
		t.Errorf("subject %q", m.Subject)
	}
	if len(m.Bcc) != 1 || m.Bcc[0] != "hidden@example.org" {
		t.Errorf("bcc %v", m.Bcc)
	}
	if m.Text != "Hello" || m.HTML != "<p>Hello</p>" {
		t.Errorf("bodies %q %q", m.Text, m.HTML)
	}
	if len(m.Attachments) != 1 || m.Attachments[0].Filename != "plan.pdf" || m.Attachments[0].Content != "JVBERi0=" {
		t.Errorf("attachments %+v", m.Attachments)
	}
	if m.InReplyTo != "earlier@example.org" || len(m.References) != 2 {
		t.Errorf("threading %q %v", m.InReplyTo, m.References)
	}
}

func TestBuildNeedsSomeoneToSendTo(t *testing.T) {
	if _, _, err := Build([]byte("From: a@b.com\r\nSubject: x\r\n\r\nhi\r\n"), "", nil); err == nil {
		t.Fatal("expected an error")
	}
}
