#!/usr/bin/env python3
"""Generate the deterministic DOCX browser-preview fixture."""

from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo
import base64
import io


def paragraph(text, style=None):
    prefix = '' if style is None else f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>'
    return f'<w:p>{prefix}<w:r><w:t>{text}</w:t></w:r></w:p>'


def line_break_paragraph(before, after):
    return f'<w:p><w:r><w:t>{before}</w:t><w:br/><w:t>{after}</w:t></w:r></w:p>'


def cell(*parts):
    return '<w:tc><w:tcPr><w:tcW w:w="3600" w:type="dxa"/></w:tcPr>' + ''.join(parts) + '</w:tc>'


long_paragraph = (
    'Shelf keeps this deliberately long paragraph readable when the preview narrows. It wraps across '
    'multiple lines without clipping a sentence, hiding the end of a block, or letting the next block '
    'overlap it. Reviewers can still scan the full explanation after the document has been loaded from cache.'
)
body = ''.join([
    paragraph('DOCX Preview Layout Verification', 'Title'),
    paragraph('Readable headings, wrapped paragraphs, and table content', 'Heading1'),
    paragraph(long_paragraph),
    paragraph(long_paragraph),
    '<w:tbl><w:tblPr><w:tblW w:w="7200" w:type="dxa"/><w:tblBorders>'
    '<w:top w:val="single"/><w:left w:val="single"/><w:bottom w:val="single"/>'
    '<w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/>'
    '</w:tblBorders></w:tblPr><w:tr>'
    + cell(paragraph('Section', 'Heading1'), line_break_paragraph('Line one', 'Line two'))
    + cell(line_break_paragraph('Long cell line one', 'Long cell line two'), paragraph('Trailing cell text remains visible.'))
    + '</w:tr><w:tr>'
    + cell(paragraph('Wrapping check'), paragraph(long_paragraph))
    + cell(line_break_paragraph('First explicit line break', 'Second explicit line break'), paragraph('Final table cell text.'))
    + '</w:tr></w:tbl>',
    paragraph('Continuation after the table', 'Heading1'),
    *(paragraph(f'Continuation {index}. {long_paragraph}') for index in range(1, 12)),
    paragraph('Trailing text after one page', 'Heading1'),
    paragraph('This final sentence must remain visible after all of the long content above.'),
])
document_xml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" '
    'w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
)
styles_xml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/>'
    '<w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1">'
    '<w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>'
)
files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': styles_xml,
    'word/document.xml': document_xml,
}
stream = io.BytesIO()
with ZipFile(stream, 'w', compression=ZIP_STORED) as archive:
    for name, content in files.items():
        entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_STORED
        archive.writestr(entry, content)
Path(__file__).with_name('preview.docx.b64').write_text(base64.b64encode(stream.getvalue()).decode() + '\n')
