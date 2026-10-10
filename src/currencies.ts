/**
 * ISO 4217 List One, published 2026-09-17; checked 2026-10-10.
 * Source: SIX (ISO 4217 Maintenance Agency), list-one.xml at
 * https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 * Include codes with defined numeric minor units, not metals/test/no-currency
 * codes marked N.A. Pin this data so server and browser use the same precision;
 * locale display defaults are not always ISO accounting precision.
 */
const codes = (
  "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD " +
  "CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP " +
  "GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR " +
  "KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK " +
  "MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR " +
  "SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH " +
  "UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAD XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
).split(" ");

export const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> =
  Object.freeze({
    ...Object.fromEntries(codes.map((code) => [code, 2])),
    ...Object.fromEntries(
      "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF"
        .split(" ")
        .map((code) => [code, 0]),
    ),
    ...Object.fromEntries(
      "BHD IQD JOD KWD LYD OMR TND".split(" ").map((code) => [code, 3]),
    ),
    CLF: 4,
    UYW: 4,
  });

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_MINOR_DIGITS).sort();
