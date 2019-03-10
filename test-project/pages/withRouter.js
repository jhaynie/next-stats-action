import { withRouter } from 'next/router'

function useWithRouter (props) {
  return (
    <div>I use withRouter</div>
  )
}

export default withRouter(useWithRouter)