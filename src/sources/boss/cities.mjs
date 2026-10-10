// Public platform identifiers; unsupported names are explicit instead of changing the search location.
const codes = {
  北京: "101010100",
  上海: "101020100",
  广州: "101280100",
  深圳: "101280600",
  杭州: "101210100",
  成都: "101270100",
  南京: "101190100",
  武汉: "101200100",
  西安: "101110100",
  苏州: "101190400",
  长沙: "101250100",
  郑州: "101180100",
  重庆: "101040100",
  天津: "101030100",
  合肥: "101220100",
  厦门: "101230200",
  济南: "101120100",
  青岛: "101120200",
  大连: "101070200",
  宁波: "101210400",
  福州: "101230100",
  东莞: "101281600",
  珠海: "101280700",
  佛山: "101280800",
  昆明: "101290100",
  贵阳: "101260100",
  太原: "101100100",
  南昌: "101240100",
  南宁: "101300100",
  石家庄: "101090100",
  哈尔滨: "101050100",
  长春: "101060100",
  沈阳: "101070100",
  海口: "101310100",
  兰州: "101160100",
  乌鲁木齐: "101130100",
  无锡: "101190200",
  常州: "101191100",
  温州: "101210700",
  惠州: "101280300",
};
export function bossCityCode(city) {
  if (city === undefined || city === null || city === "" || city === "全国")
    return undefined;
  if (typeof city === "string" && /^\d{9}$/.test(city)) return city;
  const code = codes[String(city).trim().replace(/市$/, "")];
  if (!code)
    throw Object.assign(Error("Boss 尚未核验此城市编码，请选择支持的城市。"), {
      code: "boss_city_unsupported",
      retryable: false,
    });
  return code;
}
