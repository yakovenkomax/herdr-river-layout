// JetBrains' Dark theme (as in WebStorm), as a TextMate theme for Shiki: the token colors only.
const TEXT = "#bcbec4";

const rule = (foreground, ...scope) => ({ scope, settings: { foreground } });

export default {
  name: "webstorm-dark",
  type: "dark",
  colors: { "editor.foreground": TEXT, "editor.background": "#1e1f22" },
  tokenColors: [
    { settings: { foreground: TEXT } },
    rule("#7a7e85", "comment", "punctuation.definition.comment"),
    rule("#6aab73", "string", "string.quoted", "string.template", "punctuation.definition.string"),
    rule("#42c3d4", "string.regexp"),
    rule("#cf8e6d", "constant.character.escape", "punctuation.definition.template-expression", "punctuation.section.embedded"),
    rule("#cf8e6d", "keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression",
      "keyword.operator.logical.python", "variable.language", "constant.language"),
    rule(TEXT, "keyword.operator", "punctuation", "meta.brace", "keyword.operator.assignment", "keyword.operator.arithmetic", "keyword.operator.comparison",
      "keyword.operator.logical", "keyword.operator.type.annotation", "keyword.operator.optional", "keyword.operator.spread", "keyword.operator.ternary"),
    rule(TEXT, "storage.type.function.arrow"),
    rule("#2aacb8", "constant.numeric"),
    rule("#56a8f5", "entity.name.function", "support.function", "meta.function-call entity.name.function", "meta.definition.method entity.name.function"),
    rule("#c77dbb", "variable.other.property", "variable.other.object.property", "meta.object-literal.key", "support.type.property-name",
      "variable.other.constant.property", "meta.property-name", "variable.other.enummember"),
    rule(TEXT, "variable", "variable.other.readwrite", "variable.parameter", "variable.other.constant", "entity.name.type", "support.type", "support.class",
      "entity.name.class", "entity.other.inherited-class", "support.type.primitive"),
    rule("#16baac", "entity.name.type.parameter"),
    rule("#d5b778", "entity.name.tag", "support.class.component", "punctuation.definition.tag"),
    rule(TEXT, "entity.other.attribute-name"),
    rule("#b3ae60", "meta.decorator", "punctuation.decorator", "entity.name.function.decorator"),
    rule("#c77dbb", "support.type.property-name.css", "meta.property-name.css", "support.type.property-name.json", "entity.name.tag.yaml"),
    rule("#d5b778", "entity.name.tag.css", "entity.other.attribute-name.class.css", "entity.other.attribute-name.id.css"),
    rule("#56a8f5", "markup.heading", "entity.name.section"),
    rule("#6aab73", "markup.inline.raw", "markup.fenced_code"),
  ],
};
