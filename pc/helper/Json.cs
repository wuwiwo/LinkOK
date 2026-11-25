// LinkOK helper — minimal JSON reader/writer.
//
// .NET Framework 4.8 has no System.Text.Json, so this file hand-rolls the tiny
// subset of JSON that PROTOCOL.md §11 needs: one flat object per line, no
// escaping of non-ASCII (Chinese must stay readable in the byte stream).
//
// Kept deliberately small and authority-free:
//   * Writer: ordered properties, so emitted lines have a stable field order.
//   * Reader: objects/arrays/strings/numbers/bools/null, enough to read commands.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace LinkOK.Helper
{
    /// <summary>Thrown when a protocol line is not valid JSON.</summary>
    [Serializable]
    internal sealed class JsonException : Exception
    {
        public JsonException(string message) : base(message) { }
    }

    /// <summary>
    /// Builds one JSON object. Properties keep insertion order so emitted event
    /// lines are byte-stable and easy to diff in the Hub logs.
    /// </summary>
    internal sealed class JsonWriter
    {
        private readonly StringBuilder _sb = new StringBuilder(512);
        private bool _first = true;

        public JsonWriter()
        {
            _sb.Append('{');
        }

        private void Name(string name)
        {
            if (!_first) _sb.Append(',');
            _first = false;
            Quote(name);
            _sb.Append(':');
        }

        private void Quote(string value)
        {
            _sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\b': _sb.Append("\\b"); break;
                    case '\f': _sb.Append("\\f"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    default:
                        if (c < ' ' || c == '\u007f')
                        {
                            _sb.Append("\\u");
                            _sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            // Chinese and every other printable character stay literal.
                            _sb.Append(c);
                        }
                        break;
                }
            }
            _sb.Append('"');
        }

        public JsonWriter Prop(string name, string value)
        {
            Name(name);
            if (value == null) _sb.Append("null");
            else Quote(value);
            return this;
        }

        public JsonWriter Prop(string name, bool value)
        {
            Name(name);
            _sb.Append(value ? "true" : "false");
            return this;
        }

        public JsonWriter Prop(string name, long value)
        {
            Name(name);
            _sb.Append(value.ToString(CultureInfo.InvariantCulture));
            return this;
        }

        public JsonWriter Prop(string name, int value)
        {
            return Prop(name, (long)value);
        }

        public string Close()
        {
            _sb.Append('}');
            return _sb.ToString();
        }
    }

    /// <summary>Reader for the command lines arriving on stdin.</summary>
    internal sealed class JsonReader
    {
        private readonly string _text;
        private int _pos;

        private JsonReader(string text)
        {
            _text = text;
            _pos = 0;
        }

        /// <summary>Parse one JSON object. Throws <see cref="JsonException"/> on bad input.</summary>
        public static Dictionary<string, object> ParseObject(string text)
        {
            if (text == null) throw new JsonException("empty line");
            JsonReader r = new JsonReader(text);
            r.SkipWhitespace();
            if (r.Peek() != '{') throw new JsonException("expected '{'");
            object value = r.ParseValue(0);
            r.SkipWhitespace();
            if (r._pos != r._text.Length) throw new JsonException("trailing characters after object");
            Dictionary<string, object> obj = value as Dictionary<string, object>;
            if (obj == null) throw new JsonException("not an object");
            return obj;
        }

        public static string Str(Dictionary<string, object> obj, string key)
        {
            object v;
            if (obj == null || !obj.TryGetValue(key, out v)) return null;
            if (v == null) return null;
            string s = v as string;
            if (s != null) return s;
            // Be forgiving: numbers/bools in a string slot get stringified.
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static bool Bool(Dictionary<string, object> obj, string key, bool fallback)
        {
            object v;
            if (obj == null || !obj.TryGetValue(key, out v) || v == null) return fallback;
            if (v is bool) return (bool)v;
            string s = v as string;
            if (s != null)
            {
                if (string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(s, "false", StringComparison.OrdinalIgnoreCase)) return false;
            }
            return fallback;
        }

        private char Peek()
        {
            if (_pos >= _text.Length) throw new JsonException("unexpected end of input");
            return _text[_pos];
        }

        private void SkipWhitespace()
        {
            while (_pos < _text.Length)
            {
                char c = _text[_pos];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') _pos++;
                else break;
            }
        }

        private object ParseValue(int depth)
        {
            if (depth > 32) throw new JsonException("nesting too deep");
            SkipWhitespace();
            char c = Peek();
            switch (c)
            {
                case '{': return ParseObjectBody(depth);
                case '[': return ParseArrayBody(depth);
                case '"': return ParseString();
                case 't':
                    Expect("true");
                    return true;
                case 'f':
                    Expect("false");
                    return false;
                case 'n':
                    Expect("null");
                    return null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                    throw new JsonException("unexpected character '" + c + "'");
            }
        }

        private void Expect(string literal)
        {
            if (string.CompareOrdinal(_text, _pos, literal, 0, literal.Length) != 0)
            {
                throw new JsonException("expected '" + literal + "'");
            }
            _pos += literal.Length;
        }

        private Dictionary<string, object> ParseObjectBody(int depth)
        {
            Dictionary<string, object> obj = new Dictionary<string, object>(StringComparer.Ordinal);
            _pos++; // '{'
            SkipWhitespace();
            if (Peek() == '}')
            {
                _pos++;
                return obj;
            }
            while (true)
            {
                SkipWhitespace();
                if (Peek() != '"') throw new JsonException("expected property name");
                string name = ParseString();
                SkipWhitespace();
                if (Peek() != ':') throw new JsonException("expected ':'");
                _pos++;
                obj[name] = ParseValue(depth + 1);
                SkipWhitespace();
                char c = Peek();
                if (c == ',')
                {
                    _pos++;
                    continue;
                }
                if (c == '}')
                {
                    _pos++;
                    return obj;
                }
                throw new JsonException("expected ',' or '}'");
            }
        }

        private List<object> ParseArrayBody(int depth)
        {
            List<object> list = new List<object>();
            _pos++; // '['
            SkipWhitespace();
            if (Peek() == ']')
            {
                _pos++;
                return list;
            }
            while (true)
            {
                list.Add(ParseValue(depth + 1));
                SkipWhitespace();
                char c = Peek();
                if (c == ',')
                {
                    _pos++;
                    continue;
                }
                if (c == ']')
                {
                    _pos++;
                    return list;
                }
                throw new JsonException("expected ',' or ']'");
            }
        }

        private string ParseString()
        {
            _pos++; // opening quote
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (_pos >= _text.Length) throw new JsonException("unterminated string");
                char c = _text[_pos++];
                if (c == '"') return sb.ToString();
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (_pos >= _text.Length) throw new JsonException("unterminated escape");
                char e = _text[_pos++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (_pos + 4 > _text.Length) throw new JsonException("bad \\u escape");
                        string hex = _text.Substring(_pos, 4);
                        int code;
                        if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                        {
                            throw new JsonException("bad \\u escape");
                        }
                        sb.Append((char)code);
                        _pos += 4;
                        break;
                    default:
                        throw new JsonException("bad escape '\\" + e + "'");
                }
            }
        }

        private object ParseNumber()
        {
            int start = _pos;
            if (Peek() == '-') _pos++;
            bool fractional = false;
            while (_pos < _text.Length)
            {
                char c = _text[_pos];
                if (c >= '0' && c <= '9') { _pos++; continue; }
                if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
                {
                    if (c == '.' || c == 'e' || c == 'E') fractional = true;
                    _pos++;
                    continue;
                }
                break;
            }
            string raw = _text.Substring(start, _pos - start);
            if (raw.Length == 0) throw new JsonException("bad number");
            if (!fractional)
            {
                long l;
                if (long.TryParse(raw, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out l)) return l;
            }
            double d;
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            throw new JsonException("bad number '" + raw + "'");
        }
    }
}
