// Minimal JSON reader for the converted level/model files.
//
// The server only ever reads small, machine-generated JSON (level definitions,
// the model manifest), so this is a compact strict parser with no dependency:
// objects keep their keys in an order-preserving vector, numbers are doubles,
// strings decode the standard escapes (\uXXXX included).
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

namespace ie {

class Json {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Json() : type_(Type::Null) {}
  explicit Json(bool b) : type_(Type::Bool), bool_(b) {}
  explicit Json(double n) : type_(Type::Number), num_(n) {}
  explicit Json(const std::string& s) : type_(Type::String), str_(s) {}
  explicit Json(std::vector<Json> a) : type_(Type::Array), arr_(std::move(a)) {}

  static Json object() {
    Json j;
    j.type_ = Type::Object;
    return j;
  }

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isObject() const { return type_ == Type::Object; }
  bool isArray() const { return type_ == Type::Array; }
  bool isString() const { return type_ == Type::String; }
  bool isNumber() const { return type_ == Type::Number; }
  bool isBool() const { return type_ == Type::Bool; }

  bool asBool(bool def = false) const { return type_ == Type::Bool ? bool_ : def; }
  double asNumber(double def = 0) const { return type_ == Type::Number ? num_ : def; }
  int asInt(int def = 0) const { return type_ == Type::Number ? static_cast<int>(num_) : def; }
  const std::string& asString() const { return str_; }
  std::string asString(const std::string& def) const {
    return type_ == Type::String ? str_ : def;
  }

  const std::vector<Json>& items() const { return arr_; }

  /** Object lookup; returns a shared null when absent. */
  const Json& operator[](const std::string& key) const {
    static const Json kNull;
    if (type_ != Type::Object) return kNull;
    auto it = obj_.find(key);
    return it == obj_.end() ? kNull : it->second;
  }
  bool has(const std::string& key) const { return obj_.count(key) != 0; }
  void set(const std::string& key, Json value) { obj_[key] = std::move(value); }
  const std::map<std::string, Json>& fields() const { return obj_; }

  /** Parses `text`; throws std::runtime_error on malformed input. */
  static Json parse(const std::string& text);

  /** Serialises back (used by tests and the --dump-levels helper). */
  std::string dump() const;

 private:
  Type type_;
  bool bool_ = false;
  double num_ = 0;
  std::string str_;
  std::vector<Json> arr_;
  std::map<std::string, Json> obj_;
};

}  // namespace ie
