declare module "papaparse" {
  export type ParseError = { message: string };
  export type ParseMeta = { fields?: string[] };
  export type ParseResult<T> = {
    data: T[];
    errors: ParseError[];
    meta: ParseMeta;
  };

  export function parse<T>(
    input: string,
    config: { header?: boolean; skipEmptyLines?: boolean }
  ): ParseResult<T>;

  export function unparse<T>(data: T[]): string;

  const Papa: {
    parse: typeof parse;
    unparse: typeof unparse;
  };

  export default Papa;
}
