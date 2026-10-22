// SHA-256 + BIP-340 vectors (the same official set the browser tests use).
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../src/crypto.h"
#include "../src/nostr.h"
#include "../src/nostr_crypto.h"

using namespace ie::nostr;

namespace {

int failures = 0;

void check(bool cond, const std::string& what) {
  if (!cond) {
    std::printf("FAIL %s\n", what.c_str());
    failures++;
  }
}

Key32 key(const std::string& hex) {
  const std::vector<uint8_t> b = hexDecode(hex);
  Key32 out{};
  std::memcpy(out.data(), b.data(), std::min<size_t>(32, b.size()));
  return out;
}

Sig64 sig(const std::string& hex) {
  const std::vector<uint8_t> b = hexDecode(hex);
  Sig64 out{};
  std::memcpy(out.data(), b.data(), std::min<size_t>(64, b.size()));
  return out;
}

std::vector<uint8_t> msg(const std::string& hex) { return hexDecode(hex); }

struct Vector {
  const char* sk;
  const char* pk;
  const char* aux;
  const char* message;
  const char* signature;
  bool ok;
};

// https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv
const Vector kVectors[] = {
    {"0000000000000000000000000000000000000000000000000000000000000003",
     "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0",
     true},
    {"B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "0000000000000000000000000000000000000000000000000000000000000001",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A",
     true},
    {"C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9",
     "DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8",
     "C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906",
     "7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C",
     "5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7",
     true},
    {"0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710",
     "25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517",
     "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
     "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
     "7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3",
     true},
    {"",
     "D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9",
     "",
     "4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703",
     "00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4",
     true},
    {"",
     "EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
     false},
    {"",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "FFF97BD5755EEEA420453A14355235D382F6472F8568A18B2F057A14602975563CC27944640AC607CD107AE10923D9EF7A73C643E166BE5EBEAFA34B1AC553E2",
     false},
    {"",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "0000000000000000000000000000000000000000000000000000000000000000123DDA8328AF9C23A94C1FEECFD123BA4FB73476F0D594DCB65C6425BD186051",
     false},
    {"",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "4A298DACAE57395A15D0795DDBFD1DCB564DA82B0F269BC70A74F8220429BA1D69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
     false},
    {"",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
     false},
    {"",
     "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
     false},
    {"",
     "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC30",
     "",
     "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
     "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
     false},
    {"0340034003400340034003400340034003400340034003400340034003400340",
     "778CAA53B4393AC467774D09497A87224BF9FAB6F6E68B23086497324D6FD117",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "",
     "71535DB165ECD9FBBC046E5FFAEA61186BB6AD436732FCCC25291A55895464CF6069CE26BF03466228F19A3A62DB8A649F2D560FAC652827D1AF0574E427AB63",
     true},
    {"0340034003400340034003400340034003400340034003400340034003400340",
     "778CAA53B4393AC467774D09497A87224BF9FAB6F6E68B23086497324D6FD117",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "11",
     "08A20A0AFEF64124649232E0693C583AB1B9934AE63B4C3511F3AE1134C6A303EA3173BFEA6683BD101FA5AA5DBC1996FE7CACFC5A577D33EC14564CEC2BACBF",
     true},
    {"0340034003400340034003400340034003400340034003400340034003400340",
     "778CAA53B4393AC467774D09497A87224BF9FAB6F6E68B23086497324D6FD117",
     "0000000000000000000000000000000000000000000000000000000000000000",
     "0102030405060708090A0B0C0D0E0F1011",
     "5130F39A4059B43BC7CAC09A19ECE52B5D8699D1A71E3C52DA9AFDB6B50AC370C4A482B77BF960F8681540E25B6771ECE1E5A37FD80E5A51897C5566A97EA5A5",
     true},
};

}  // namespace

int main() {
  check(ie::nostr::hexEncode(sha256(std::string(""))) ==
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "sha256(empty)");
  check(ie::nostr::hexEncode(sha256(std::string("abc"))) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "sha256(abc)");

  int index = 0;
  for (const Vector& v : kVectors) {
    const Key32 pub = key(v.pk);
    const Sig64 signature = sig(v.signature);
    const std::vector<uint8_t> message = msg(v.message);
    const uint8_t* m = message.empty() ? reinterpret_cast<const uint8_t*>("") : message.data();
    if (std::strlen(v.sk) == 64) {
      const Key32 sk = key(v.sk);
      std::string havePub = ie::nostr::hexEncode(pubkeyOf(sk));
      std::string wantPub = v.pk;
      for (char& c : havePub) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
      for (char& c : wantPub) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
      check(havePub == wantPub, "vector " + std::to_string(index) + " pubkey");
      const Sig64 made = schnorrSign(m, message.size(), sk, key(v.aux));
      // The CSV is upper-case; compare case-insensitively.
      std::string madeHex = ie::nostr::hexEncode(made);
      std::string want = v.signature;
      for (char& c : madeHex) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
      for (char& c : want) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
      check(madeHex == want, "vector " + std::to_string(index) + " sign");
    }
    check(schnorrVerify(m, message.size(), pub, signature) == v.ok,
          "vector " + std::to_string(index) + " verify");
    index++;
  }

  // ------------------------------------------------------ events + rooms
  {
    Key32 sk{};
    for (int i = 0; i < 32; i++) sk[i] = static_cast<uint8_t>(0x40 + i);
    const std::string pub = ie::nostr::hexEncode(ie::nostr::pubkeyOf(sk));
    const int64_t now = 1700000000;

    ie::nostr::RoomContent content;
    content.game = "ctf-easy";
    content.type = "CTF";
    content.title = "Capture the Flag \u00b7 Easy";  // non-ASCII like the client
    content.host = "Dedicated Test";
    content.players = 2;
    content.maxPlayers = 8;
    content.ice = {"stun:stun.l.google.com:19302"};
    content.created = now;
    const ie::nostr::Event room = ie::nostr::makeRoomEvent("0123456789abcdef01234567", content,
                                                           1800, sk, now);
    check(room.kind == ie::nostr::kKindRoom, "room kind");
    check(room.verify(), "room verify");
    check(room.pubkey == pub, "room author");
    auto tag = [&](const char* name) {
      for (const auto& t : room.tags) {
        if (t.size() >= 2 && t[0] == name) return t[1];
      }
      return std::string();
    };
    check(tag("d") == "0123456789abcdef01234567", "room d tag");
    check(tag("expiration") == std::to_string(now + 1800), "room expiration");
    check(tag("p") == ie::nostr::kRoomBoardPubkey, "room p tag (board profile)");
    try {
      const ie::Json parsed = ie::Json::parse(room.content);
      check(parsed["v"].asInt() == 1, "room content v");
      check(parsed["game"].asString() == "ctf-easy", "room content game");
      check(parsed["title"].asString() == content.title, "room content title");
      check(parsed["players"].asInt() == 2, "room content players");
      check(parsed["max"].asInt() == 8, "room content max");
      check(parsed["ice"].isArray() && parsed["ice"].items().size() == 1, "room content ice");
      check(parsed["created"].asNumber() == static_cast<double>(now), "room content created");
    } catch (const std::exception& e) {
      check(false, std::string("room content parse: ") + e.what());
    }
    // Tampering breaks the id/signature.
    ie::nostr::Event tampered = room;
    tampered.content += " ";
    check(!tampered.verify(), "tampered event rejected");

    const ie::nostr::Event del = ie::nostr::makeDeletionEvent("0123456789abcdef01234567", sk, now);
    check(del.kind == ie::nostr::kKindDelete, "deletion kind");
    check(del.verify(), "deletion verify");
    std::string aTag;
    for (const auto& t : del.tags) {
      if (t.size() >= 2 && t[0] == "a") aTag = t[1];
    }
    check(aTag == "30333:" + pub + ":0123456789abcdef01234567", "deletion a tag");

    // Host certificate + answer/auth payloads (must match mp/cert.ts).
    auto p256 = ie::nostr::P256::generate();
    check(p256 != nullptr, "p256 keygen");
    ie::nostr::HostCert cert;
    cert.key = p256->spkiBase64();
    cert.created = now;
    cert.expires = now + 3600;
    check(cert.key.size() > 100, "cert spki");
    const std::string certMsg = ie::nostr::certPayload("0123456789abcdef01234567", pub, cert);
    cert.sig = ie::nostr::signHex(sk, reinterpret_cast<const uint8_t*>(certMsg.data()), certMsg.size());
    check(ie::nostr::verifyHex(ie::nostr::pubkeyOf(sk), reinterpret_cast<const uint8_t*>(certMsg.data()),
                               certMsg.size(), cert.sig), "cert signature");
    const std::string answerMsg = ie::nostr::answerPayload(
        "0123456789abcdef01234567", pub, "guestpub", "v=0\r\n");
    const std::string answerSig = p256->signBase64(
        reinterpret_cast<const uint8_t*>(answerMsg.data()), answerMsg.size());
    auto verifyP256 = [&](const std::string& msg, const std::string& sigB64) {
      const std::vector<uint8_t> raw = ie::base64Decode(sigB64);
      const std::vector<uint8_t> spki = ie::base64Decode(cert.key);
      if (raw.size() != 64 || spki.empty()) return false;
      const std::string der(spki.begin(), spki.end());
      return ie::nostr::p256VerifySpki(
          der, reinterpret_cast<const uint8_t*>(msg.data()), msg.size(), raw.data());
    };
    check(verifyP256(answerMsg, answerSig), "answer signature verifies");
    std::string tamperedAnswer = answerMsg;
    tamperedAnswer[0] ^= 1;
    check(!verifyP256(tamperedAnswer, answerSig), "tampered answer rejected");
    const std::string authMsg = ie::nostr::authPayload(
        "0123456789abcdef01234567", pub, "guestpub", "0123456789abcdef0123456789abcdef");
    const std::string authSig = ie::nostr::signHex(sk, reinterpret_cast<const uint8_t*>(authMsg.data()),
                                                   authMsg.size());
    check(ie::nostr::verifyHex(ie::nostr::pubkeyOf(sk), reinterpret_cast<const uint8_t*>(authMsg.data()),
                               authMsg.size(), authSig), "channel auth signature");

    // Signalling: addressed to the host, parsed only by the host.
    ie::nostr::Signal sig;
    sig.kind = "offer";
    sig.sdp = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n";
    sig.name = "Guest Pilot";
    ie::nostr::Candidate cand;
    cand.candidate = "candidate:1 1 udp 2130706431 192.168.1.5 54321 typ host";
    cand.sdpMid = "0";
    cand.sdpMLineIndex = 0;
    sig.candidates.push_back(cand);
    const ie::nostr::Event signal = ie::nostr::makeSignalEvent("0123456789abcdef01234567", pub, sig, sk, now);
    check(signal.kind == ie::nostr::kKindSignal, "signal kind");
    check(signal.verify(), "signal verify");
    ie::nostr::Signal parsed;
    check(ie::nostr::parseSignal(signal, pub, "0123456789abcdef01234567", &parsed), "signal parse");
    check(parsed.kind == "offer" && parsed.sdp == sig.sdp, "signal sdp");
    check(parsed.name == "Guest Pilot", "signal name");
    check(parsed.candidates.size() == 1 && parsed.candidates[0].sdpMid == "0", "signal candidates");
    check(!ie::nostr::parseSignal(signal, "ffff", "0123456789abcdef01234567", &parsed),
          "signal for someone else rejected");
    check(!ie::nostr::parseSignal(signal, pub, "ffffffffffffffffffffffff", &parsed),
          "signal for another room rejected");
  }

  if (failures == 0) {
    std::printf("nostr: all checks passed (%d BIP-340 vectors + events)\n", index);
    return 0;
  }
  std::printf("nostr: %d failures\n", failures);
  return 1;
}
