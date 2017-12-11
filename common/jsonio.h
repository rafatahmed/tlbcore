#pragma once
#include <cctype>
#include <armadillo>
#include "./chunk_file.h"

/*
  Define JSON mappings for C++ types, including the primitive types and containers. You can
  add support for your own types by adding wrJson, wrJsonSize and rdJson functions.

  The mapping between a statically typed data structure and JSON is subtle. The same JSON could
  read into different C++ types depending on what types rdJson is called with.

  jsonstr is a json-encoded result. It can be further part of a data structure, so you can put
  arbitrary dynamically typed data in there.

  I think this is fairly compatible with browser JSON. JSON is written without spaces or newlines,
  but they are tolerated in the input. Possible bugs lurk in the following places:
   - UTF-8 encoding of wacky characters in strings.
   - Special floating point values like NaN or Inf.
   - Reading of malformed input, such as objects with repeated keys

*/

struct jsonstr {
  // WRITEME: ensure move semantics work for efficient return values
  explicit jsonstr();
  explicit jsonstr(string const &_it);
  explicit jsonstr(const char *str);
  explicit jsonstr(const char *begin, const char *end);

  jsonstr(jsonstr &&other) noexcept = default; // :it(std::move(other.it)), blobs(std::move(other.blobs)) {}
  jsonstr(jsonstr const &other) = default;
  jsonstr & operator= (const jsonstr & other) = default;
  jsonstr & operator= (jsonstr && other) = default;
  ~jsonstr();

  // Use this api to efficiently create a string of a given maximum size `n`. Write and advance
  // the pointer until the end, then call endWrite which will set the final size of the string
  char *startWrite(size_t n);
  void endWrite(char const *p);

  void useBlobs(string const &_fn);
  void setNull();

  bool isNull() const;
  bool isString(char const *s) const;

  // Read and write to files.
  // Read returns -1 with errno=ENOENT if not found.
  // Otherwise, these throw runtime errors if anything else goes wrong.
  void writeToFile(string const &fn, bool enableGzip=true) const;
  int readFromFile(string const &fn);

  string it;
  shared_ptr< ChunkFile > blobs;
};

ostream & operator<<(ostream &s, jsonstr const &obj);

jsonstr interpolate(jsonstr const &a, jsonstr const &b, double cb);
jsonstr addGradient(jsonstr const &a, jsonstr const &grad, double learningRate);

#include "./jsonio_parse.h"
#include "./jsonio_types.h"


/*
  The high level API is asJson and fromJson
*/

template <typename T>
void toJson(jsonstr &ret, const T &value) {
  WrJsonContext ctx;
  ctx.blobs = ret.blobs;
  wrJsonSize(ctx, value);
  ctx.s = ret.startWrite(ctx.size);
  wrJson(ctx, value);
  ret.endWrite(ctx.s);
}

template <typename T>
jsonstr asJson(const T &value) {
  jsonstr ret;
  toJson(ret, value);
  return ret;
}


template <typename T>
bool fromJson(jsonstr const &sj, T &value) {
  RdJsonContext ctx;
  ctx.s = sj.it.c_str();
  ctx.blobs = sj.blobs;
  return rdJson(ctx, value);
}

template <typename T>
bool fromJson(jsonstr const &sj, bool noTypeCheck, T &value) {
  RdJsonContext ctx;
  ctx.s = sj.it.c_str();
  ctx.blobs = sj.blobs;
  ctx.noTypeCheck = noTypeCheck;
  return rdJson(ctx, value);
}

template <typename T>
bool fromJson(string const &ss, shared_ptr< ChunkFile > const &blobs, T &value) {
  RdJsonContext ctx;
  ctx.s = ss.c_str();
  ctx.blobs = blobs;
  return rdJson(ctx, value);
}

template <typename T>
bool fromJson(string const &ss, T &value) {
  RdJsonContext ctx;
  ctx.s = ss.c_str();
  return rdJson(ctx, value);
}


template <typename T>
bool fromJson(string const &ss, bool noTypeCheck, T &value) {
  RdJsonContext ctx;
  ctx.s = ss.c_str();
  ctx.noTypeCheck = noTypeCheck;
  return rdJson(ctx, value);
}
