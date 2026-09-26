'use strict'
// Dependency-free VSIX (ZIP store records). Builds only the two reviewed extension files.
const fs = require('node:fs'), path = require('node:path')
const directory = path.join(__dirname, '..', 'integrations')
const manifest = '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="allpet-terminal-bridge" Version="1.0.0" Publisher="allpet"/><DisplayName>AllPet Terminal Bridge</DisplayName><Description xml:space="preserve">AllPet terminal identity and focus bridge</Description><Tags>terminal</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.85.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>'
const files = { 'extension.vsixmanifest': Buffer.from(manifest), '[Content_Types].xml': Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>') }
for (const name of ['package.json','extension.js']) files[`extension/${name}`] = fs.readFileSync(path.join(directory,'vscode',name))
function crc32(buffer) { let crc=0xffffffff; for(const byte of buffer) { crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0) }; return (crc^0xffffffff)>>>0 }
const local=[], central=[]; let offset=0
for (const [name,data] of Object.entries(files)) {
  const filename=Buffer.from(name), crc=crc32(data), header=Buffer.alloc(30), entry=Buffer.alloc(46)
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(filename.length,26)
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20,4); entry.writeUInt16LE(20,6); entry.writeUInt32LE(crc,16); entry.writeUInt32LE(data.length,20); entry.writeUInt32LE(data.length,24); entry.writeUInt16LE(filename.length,28); entry.writeUInt32LE(offset,42)
  local.push(header,filename,data); central.push(entry,filename); offset+=header.length+filename.length+data.length
}
const cd=Buffer.concat(central), end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length,8); end.writeUInt16LE(Object.keys(files).length,10); end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16)
const output=path.join(directory,'allpet-terminal-bridge.vsix'); fs.writeFileSync(output,Buffer.concat([...local,cd,end])); console.log(output)
