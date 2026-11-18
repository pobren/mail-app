# End to end check of the bridge against a local Mail App (npm run dev:local) with a mailbox chris@example.com.
# Start the bridge with --headless, connect it on its settings page, then:
#   python3 imap_test.py <bridge password> <API key>
import imaplib, time, json, sys, urllib.request, email
PW=sys.argv[1]; KEY=sys.argv[2]
API="http://127.0.0.1:5173/api/ext/v1/mailboxes/chris%40example.com"
def api(method, path, body=None, ctype="application/json"):
    req=urllib.request.Request(API+path, data=body, method=method, headers={"Authorization":"Bearer "+KEY,"Content-Type":ctype})
    with urllib.request.urlopen(req) as r: return json.loads(r.read() or b"null")
ok=0; bad=0
def check(name, cond, extra=""):
    global ok,bad
    if cond: ok+=1; print("PASS",name)
    else: bad+=1; print("FAIL",name,extra)

M=imaplib.IMAP4("127.0.0.1",1143)
try:
    M.login("chris@example.com","wrong"); check("bad password refused",False)
except imaplib.IMAP4.error: check("bad password refused",True)
M=imaplib.IMAP4("127.0.0.1",1143)
typ,_=M.login("Chris@Example.com",PW); check("login",typ=="OK")
typ,lst=M.list(); names=[l.decode() for l in lst]; print(names)
check("list has INBOX and Bin", any('"INBOX"' in n or ' INBOX' in n for n in names) and any("Bin" in n and "\\Trash" in n for n in names))
check("hidden folders not listed", not any("Snoozed" in n for n in names))
typ,d=M.select("INBOX"); n0=int(d[0]); check("select inbox", typ=="OK" and n0>=1, d)
typ,d=M.uid("FETCH","1:*","(UID RFC822.SIZE FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])")
check("header fetch", typ=="OK" and b"RFC822.SIZE" in d[0][0], d[:1])
# new mail via API appears with IDLE-free NOOP after poll
raw=b"From: Sam <sam@example.org>\r\nTo: chris@example.com\r\nSubject: Second test\r\nMessage-ID: <abc2@example.org>\r\nDate: Wed, 18 Nov 2026 11:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nLine one\r\n.dot line\r\n"
newid=api("POST","/append?folder=inbox&read=0",raw,"message/rfc822")["id"]
# IDLE
M.send(b"a1 IDLE\r\n"); print(M.readline())
t=time.time(); got=b""
M.sock.settimeout(30)
try:
    while time.time()-t<30:
        line=M.readline(); got+=line
        if b"EXISTS" in line: break
except Exception as e: print("idle err",e)
M.send(b"DONE\r\n"); 
while True:
    l=M.readline()
    if l.startswith(b"a1 "): break
check("IDLE told new mail quickly", b"EXISTS" in got, got)
print("idle seconds", round(time.time()-t,1))
typ,d=M.uid("SEARCH",None,"UNSEEN"); print("unseen",d)
typ,d=M.uid("SEARCH",None,"SUBJECT","Second"); uids=d[0].split(); check("search by subject", len(uids)==1, d)
u=uids[0]
typ,d=M.uid("FETCH",u,"(BODY.PEEK[])"); body=d[0][1]
check("full body matches original", body==raw, body[:200])
typ,d=M.uid("FETCH",u,"(BODYSTRUCTURE ENVELOPE)"); check("bodystructure", typ=="OK" and b"ENVELOPE" in d[0], d)
# mark read via STORE -> Mail App
M.uid("STORE",u,"+FLAGS","(\\Seen \\Flagged)")
e=api("GET","/emails/"+newid); check("seen and flagged reached Mail App", e["read"] and e["starred"], e.get("read"))
# Outlook style move: COPY + \Deleted + EXPUNGE
typ,d=M.uid("COPY",u,"Archive"); check("copy ok", typ=="OK", d)
e=api("GET","/emails/"+newid); check("copy moved it in Mail App", e["folder_id"]=="archive", e.get("folder_id"))
M.uid("STORE",u,"+FLAGS","(\\Deleted)"); typ,d=M.expunge(); check("expunge ok", typ=="OK", d)
e=api("GET","/emails/"+newid); check("still in archive after expunge (not binned)", e["folder_id"]=="archive", e.get("folder_id"))
typ,d=M.select("Archive"); check("archive has it", int(d[0])==1, d)
# MOVE to Bin then delete for good
typ,d=M.uid("SEARCH",None,"ALL"); u2=d[0].split()[-1]
typ,d=M._simple_command("UID","MOVE",u2.decode(),"Bin"); check("move to Bin", typ=="OK", d)
e=api("GET","/emails/"+newid); check("in trash in Mail App", e["folder_id"]=="trash")
M.select("Bin"); typ,d=M.uid("SEARCH",None,"ALL"); u3=d[0].split()[-1]
M.uid("STORE",u3,"+FLAGS","(\\Deleted)"); typ,d=M.expunge(); check("expunge in Bin", typ=="OK", d)
try:
    api("GET","/emails/"+newid); check("deleted for good", False)
except urllib.error.HTTPError as ex: check("deleted for good", ex.code==404)
# APPEND draft
draft=b"From: chris@example.com\r\nTo: jo@example.org\r\nSubject: Draft one\r\nMessage-ID: <d1@x>\r\n\r\nHello draft\r\n"
typ,d=M.append("Drafts","(\\Draft \\Seen)",None,draft); check("append draft", typ=="OK" and b"APPENDUID" in d[0], d)
M.select("Drafts"); typ,d=M.uid("SEARCH",None,"ALL"); check("draft listed", len(d[0].split())==1, d)
du=d[0].split()[0]; typ,d=M.uid("FETCH",du,"(FLAGS)"); check("draft flag kept", b"\\Draft" in d[0], d)
# replace draft: delete old
M.uid("STORE",du,"+FLAGS","(\\Deleted)"); typ,d=M.expunge(); check("draft expunged", typ=="OK", d)
r=api("GET","/index?folder=draft"); check("no drafts left in Mail App", len(r["emails"])==0, r)
r=api("GET","/index?folder=trash"); check("draft not left in Bin", len(r["emails"])==0, r)
# create + rename folder
typ,d=M.create("Projects"); check("create folder", typ=="OK", d)
typ,d=M.rename("Projects","Clients"); check("rename folder", typ=="OK", d)
typ,lst=M.list(); check("renamed listed", any(b"Clients" in l for l in lst), lst)
typ,d=M.delete("Clients"); check("delete folder refused", typ=="NO", d)
# change in Mail App reaches IMAP
M.select("INBOX"); typ,d=M.uid("SEARCH",None,"ALL"); first=d[0].split()[0]
r=api("GET","/index?folder=inbox"); fid=r["emails"][0]["id"]
api("PUT","/emails/"+fid, json.dumps({"read":True,"starred":True}).encode())
time.sleep(1)
M.send(b"a2 IDLE\r\n"); M.readline(); t=time.time(); got=b""
while time.time()-t<30:
    line=M.readline(); got+=line
    if b"FETCH" in line: break
M.send(b"DONE\r\n")
while not M.readline().startswith(b"a2 "): pass
check("flag change from Mail App reached IMAP", b"\\Seen" in got and b"\\Flagged" in got, got)
M.logout()
print("passed",ok,"failed",bad)
