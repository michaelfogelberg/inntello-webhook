module.exports = { transfer: async (req, res) => {
  const twilio = require('twilio')
  const twiml = new twilio.twiml.VoiceResponse()
  twiml.say({ voice: 'Polly.Astrid', language: 'sv-SE' },
    'Transfer-funktionen är inte konfigurerad ännu.'
  )
  res.type('text/xml')
  res.send(twiml.toString())
}}
