"""Fetch DGPA daily calendar CSVs listed by the government open-data portal."""
import csv, datetime as dt, html.parser, io, json, pathlib, re, urllib.parse, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = 'https://data.gov.tw/dataset/14718'
def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 HeremayHolidaySync/1.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw=response.read()
        try: return raw.decode('utf-8-sig')
        except UnicodeDecodeError: return raw.decode('cp950')
class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(); self.years = {}
    def handle_starttag(self, tag, attrs):
        if tag != 'a': return
        url = dict(attrs).get('href', '')
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname != 'www.dgpa.gov.tw': return
        query = urllib.parse.parse_qs(parsed.query)
        name = query.get('name', [''])[0]
        filename = query.get('filename', [''])[0]
        match = re.match(r'(\d{3})年', name)
        if match and filename.endswith('.csv') and 'Google' not in name:
            # The portal lists revisions after original releases; retain the last revision.
            self.years[int(match[1]) + 1911] = url
def parse_csv(text, year):
    days = {}
    for row in csv.DictReader(io.StringIO(text.lstrip('\ufeff'))):
        date = dt.datetime.strptime(row['西元日期'].strip(), '%Y%m%d').date()
        if date.year != year: raise ValueError('Unexpected year in CSV')
        flag = row['是否放假'].strip()
        if flag not in ('0', '2'): raise ValueError('Unknown holiday flag')
        if date.isoformat() in days: raise ValueError('Duplicate date')
        days[date.isoformat()] = {'isHoliday': flag == '2', 'name': row.get('備註', '').strip()}
    expected = (dt.date(year + 1, 1, 1) - dt.date(year, 1, 1)).days
    if len(days) != expected: raise ValueError('Incomplete calendar CSV')
    return days
def main():
    destination = ROOT / 'data' / 'official-holidays.json'
    old = json.loads(destination.read_text()) if destination.exists() else {'schemaVersion': 1, 'source': SOURCE, 'years': {}}
    links = Links(); links.feed(fetch(SOURCE))
    current = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).year
    targets = {year: url for year, url in links.years.items() if current-1 <= year <= current+2}
    if current not in targets: raise ValueError('Current year missing from official dataset listing')
    # Validate every fetched year before writing; any error preserves the prior file.
    updated = dict(old['years'])
    for year, url in targets.items():
        updated[str(year)] = {'source': url, 'days': parse_csv(fetch(url), year)}
    output = {'schemaVersion': 1, 'source': SOURCE, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'years': updated}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print('Updated official holiday years:', ', '.join(map(str, sorted(targets))))
if __name__ == '__main__': main()
