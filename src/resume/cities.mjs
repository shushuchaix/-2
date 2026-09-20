// 城市词表：用于从简历文本中识别期望城市（LLM 未给出时的兜底）
export const MAJOR_CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '武汉', '西安', '苏州',
  '天津', '重庆', '长沙', '郑州', '青岛', '合肥', '厦门', '宁波', '无锡', '佛山',
  '东莞', '济南', '福州', '大连', '沈阳', '哈尔滨', '昆明', '南昌', '贵阳', '石家庄',
  '太原', '南宁', '兰州', '常州', '南通', '温州', '嘉兴', '珠海', '中山', '惠州',
];

export const CITY_ALIAS_CANDIDATES = MAJOR_CITIES;

/** 从纯文本中猜测城市（出现频次最高的主要城市） */
export function guessCitiesFromText(text = '') {
  const counts = new Map();
  for (const c of MAJOR_CITIES) {
    const re = new RegExp(c, 'g');
    const n = (text.match(re) || []).length;
    if (n > 0) counts.set(c, n);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 3);
}
