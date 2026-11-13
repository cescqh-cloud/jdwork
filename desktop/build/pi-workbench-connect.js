const form = document.querySelector('form')
const error = document.querySelector('#error')
const button = form.querySelector('button')

form.addEventListener('submit', async event => {
  event.preventDefault()
  button.disabled = true
  error.textContent = ''
  try {
    const result = await window.piConnection.connect(new FormData(form).get('origin'))
    if (!result.ok) error.textContent = result.error
  } catch {
    error.textContent = '无法完成连接，请重新打开工作台后再试。'
  } finally { button.disabled = false }
})
