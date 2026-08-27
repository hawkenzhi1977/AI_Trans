declare module 'opencc-js' {
  type ConverterFunction = (text: string) => string;
  
  interface ConverterOptions {
    from: string;
    to: string;
  }
  
  interface OpenCC {
    Converter(options: ConverterOptions): ConverterFunction;
  }
  
  const OpenCC: OpenCC;
  export default OpenCC;
}
