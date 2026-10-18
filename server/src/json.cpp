#include "json.h"

#include <cctype>
#include <cstdio>
#include <stdexcept>

namespace ie {

namespace {

struct Parser {
  const std::string& s;
  size_t i = 0;

  explicit Parser(const std::string& text) : s(text) {}

  [[noreturn]] void fail(const std::string& what) const {
    throw std::runtime_error("json: " + what + " at offset " + std::to_string(i));
  }

  void skip() {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  }

  char peek() const { return i < s.size() ? s[i] : '\0'; }

  void expect(char c) {
    skip();
    if (peek() != c) fail(std::string("expected '") + c + "'");
    i++;
  }

  Json value() {
    skip();
    const char c = peek();
    if (c == '{') return object();
    if (c == '[') return array();
    if (c == '"') return Json(string());
    if (c == 't' || c == 'f') return Json(boolean());
    if (c == 'n') {
      literal("null");
      return Json();
    }
    if (c == '-' || (c >= '0' && c <= '9')) return Json(number());
    fail("unexpected character");
  }

  Json object() {
    expect('{');
    Json out = Json::object();
    skip();
    if (peek() == '}') {
      i++;
      return out;
    }
    for (;;) {
      skip();
      if (peek() != '"') fail("expected object key");
      const std::string key = string();
      expect(':');
      out.set(key, value());
      skip();
      if (peek() == ',') {
        i++;
        continue;
      }
      expect('}');
      return out;
    }
  }

  Json array() {
    expect('[');
    std::vector<Json> out;
    skip();
    if (peek() == ']') {
      i++;
      return Json(std::move(out));
    }
    for (;;) {
      out.push_back(value());
      skip();
      if (peek() == ',') {
        i++;
        continue;
      }
      expect(']');
      return Json(std::move(out));
    }
  }

  bool boolean() {
    if (s.compare(i, 4, "true") == 0) {
      i += 4;
      return true;
    }
    if (s.compare(i, 5, "false") == 0) {
      i += 5;
      return false;
    }
    fail("bad literal");
  }

  void literal(const char* lit) {
    const size_t n = std::char_traits<char>::length(lit);
    if (s.compare(i, n, lit) != 0) fail("bad literal");
    i += n;
  }

  std::string string() {
    expect('"');
    std::string out;
    for (;;) {
      if (i >= s.size()) fail("unterminated string");
      const char c = s[i++];
      if (c == '"') return out;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (i >= s.size()) fail("bad escape");
      const char e = s[i++];
      switch (e) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          if (i + 4 > s.size()) fail("bad \\u escape");
          unsigned cp = 0;
          for (int k = 0; k < 4; k++) {
            const char h = s[i++];
            cp <<= 4;
            if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
            else fail("bad hex digit");
          }
          // Surrogate pair.
          if (cp >= 0xD800 && cp <= 0xDBFF && s.compare(i, 2, "\\u") == 0) {
            i += 2;
            unsigned lo = 0;
            for (int k = 0; k < 4; k++) {
              const char h = s[i++];
              lo <<= 4;
              if (h >= '0' && h <= '9') lo |= static_cast<unsigned>(h - '0');
              else if (h >= 'a' && h <= 'f') lo |= static_cast<unsigned>(h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') lo |= static_cast<unsigned>(h - 'A' + 10);
              else fail("bad hex digit");
            }
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          // UTF-8 encode.
          if (cp < 0x80) out.push_back(static_cast<char>(cp));
          else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
          }
          break;
        }
        default: fail("bad escape");
      }
    }
  }

  double number() {
    const size_t start = i;
    if (peek() == '-') i++;
    while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) i++;
    if (peek() == '.') {
      i++;
      while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) i++;
    }
    if (peek() == 'e' || peek() == 'E') {
      i++;
      if (peek() == '+' || peek() == '-') i++;
      while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) i++;
    }
    if (i == start) fail("bad number");
    return std::strtod(s.substr(start, i - start).c_str(), nullptr);
  }
};

void escapeTo(const std::string& in, std::string& out) {
  out.push_back('"');
  for (const char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned>(c));
          out += buf;
        } else {
          out.push_back(c);
        }
    }
  }
  out.push_back('"');
}

}  // namespace

Json Json::parse(const std::string& text) {
  Parser p(text);
  Json v = p.value();
  p.skip();
  if (p.i != text.size()) p.fail("trailing characters");
  return v;
}

std::string Json::dump() const {
  std::string out;
  switch (type_) {
    case Type::Null: return "null";
    case Type::Bool: return bool_ ? "true" : "false";
    case Type::Number: {
      char buf[40];
      std::snprintf(buf, sizeof(buf), "%.10g", num_);
      return buf;
    }
    case Type::String:
      escapeTo(str_, out);
      return out;
    case Type::Array: {
      out.push_back('[');
      for (size_t i = 0; i < arr_.size(); i++) {
        if (i) out.push_back(',');
        out += arr_[i].dump();
      }
      out.push_back(']');
      return out;
    }
    case Type::Object: {
      out.push_back('{');
      bool first = true;
      for (const auto& [k, v] : obj_) {
        if (!first) out.push_back(',');
        first = false;
        escapeTo(k, out);
        out.push_back(':');
        out += v.dump();
      }
      out.push_back('}');
      return out;
    }
  }
  return "null";
}

}  // namespace ie
