import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFileText } from '../CanvasInterface.js';

// Small in-memory fixtures exercise the real parser APIs without downloads.
function zip(entries) {
	const local = [], central = [];
	let offset = 0;
	for (const [name, content] of entries) {
		const filename = Buffer.from(name), data = Buffer.from(content);
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
		header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
		local.push(header, filename, data);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
		directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
		central.push(directory, filename);
		offset += header.length + filename.length + data.length;
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(central.reduce((n, b) => n + b.length, 0), 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, ...central, end]);
}

function pdf(text) {
	const stream = 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		'<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream'
	];
	let result = '%PDF-1.4\n';
	const offsets = [0];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(Buffer.byteLength(result));
		result += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
	}
	const xref = Buffer.byteLength(result);
	result += 'xref\n0 6\n0000000000 65535 f \n' +
		offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
		'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
	return Buffer.from(result);
}

test('PDF text extraction uses the installed unpdf parser', async () => {
	const [text, error] = await extractFileText(pdf('Deadline October 15'), 'deadline.pdf');
	assert.equal(error, null);
	assert.match(text, /Deadline October 15/);
});

test('DOCX text extraction uses the installed mammoth parser', async () => {
	const buffer = zip([
		['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
		['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
		['word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Deadline October 15</w:t></w:r></w:p></w:body></w:document>']
	]);
	const [text, error] = await extractFileText(buffer, 'deadline.docx');
	assert.equal(error, null);
	assert.match(text, /Deadline October 15/);
});

test('ODT text extraction supports the installed officeparser AST API', async () => {
	const buffer = zip([
		['mimetype', 'application/vnd.oasis.opendocument.text'],
		['content.xml', '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p>Deadline October 15</text:p></office:text></office:body></office:document-content>']
	]);
	const [text, error] = await extractFileText(buffer, 'deadline.odt');
	assert.equal(error, null);
	assert.match(text, /Deadline October 15/);
});

test('unreadable documents report extraction errors', async () => {
	const [text, error] = await extractFileText(Buffer.from('not a pdf'), 'broken.pdf');
	assert.equal(text, null);
	assert.match(error, /Failed to extract/);
});

