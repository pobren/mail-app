# End to end check of the bridge against a local Mail App (npm run dev:local) with a mailbox chris@example.com.
# Start the bridge with --headless, connect it on its settings page, then:
#   python3 pop_smtp_test.py <bridge password> <API key>
import poplib, smtplib, sys, json, urllib.request, time
from email.message import EmailMessage
PW=sys.argv[1]; KEY=sys.argv[2]
API="http://127.0.0.1:5173/api/ext/v1/mailboxes/chris%40example.com"
def api(method, path, body=None, ctype="application/json"):
    req=urllib.request.Request(API+path, data=body, method=method, headers={"Authorization":"Bearer "+KEY,"Content-Type":ctype})
    with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"null")
ok=bad=0
def check(n,c,x=""):
    global ok,bad
    if c: ok+=1; print("PASS",n)
    else: bad+=1; print("FAIL",n,x)
P=poplib.POP3("127.0.0.1",1110)
try: P.user("chris@example.com"); P.pass_("nope"); check("pop bad pw",False)
except poplib.error_proto: check("pop bad pw",True)
P=poplib.POP3("127.0.0.1",1110); P.user("chris@example.com"); r=P.pass_(PW); check("pop login", r.startswith(b"+OK"), r)
n,size=P.stat(); inbox=api("GET","/index?folder=inbox")["emails"]; check("stat count = inbox", n==len(inbox), (n,len(inbox)))
r,lst,_=P.uidl(); ids=[l.split()[1].decode() for l in lst]; check("uidl are Mail App ids", set(ids)==set(e["id"] for e in inbox), ids)
r,lines,octets=P.retr(1); raw=b"\r\n".join(lines)+b"\r\n"
real=urllib.request.urlopen(urllib.request.Request(API+"/emails/"+ids[0]+"/raw",headers={"Authorization":"Bearer "+KEY})).read()
check("retr gives the whole email", raw.startswith(real.split(b"\r\n")[0]), raw[:80])
r,lines,_=P.top(1,0); check("top 0 lines is headers", b"" in lines and len(lines)<len(raw.split(b"\n")), len(lines))
P.dele(1); P.quit()
check("keep mail: still in inbox", any(e["id"]==ids[0] for e in api("GET","/index?folder=inbox")["emails"]))
e=api("GET","/emails/"+ids[0]); check("mark read on download", e["read"]==True)
# SMTP
S=smtplib.SMTP("127.0.0.1",1025)
S.ehlo()
try: S.login("chris@example.com","bad"); check("smtp bad pw",False)
except smtplib.SMTPAuthenticationError: check("smtp bad pw",True)
S.login("chris@example.com",PW); check("smtp login",True)
m=EmailMessage(); m["From"]="Chris <chris@example.com>"; m["To"]="jo@example.org"; m["Cc"]="sam@example.org"; m["Subject"]="From Outlook"; m["Message-ID"]="<outlook-1@example.com>"
m.set_content("Plain body"); m.add_alternative("<p>HTML body</p>",subtype="html"); m.add_attachment(b"hello file",maintype="text",subtype="plain",filename="notes.txt")
try:
    S.send_message(m, to_addrs=["jo@example.org","sam@example.org","secret@example.org"]); check("smtp send accepted", True)
except Exception as ex: check("smtp send accepted", False, repr(ex))
S.quit()
time.sleep(1)
sent=api("GET","/index?folder=sent")["emails"]; print("sent:",len(sent))
if sent:
    e=api("GET","/emails/"+sent[-1]["id"]); print({k:e.get(k) for k in ("subject","recipient","cc","bcc")}, [a["filename"] for a in e.get("attachments",[])])
    check("sent has bcc from envelope", "secret@example.org" in (e.get("bcc") or ""), e.get("bcc"))
print("passed",ok,"failed",bad)
